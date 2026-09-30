/**
 * #platform-tabs — the shell's five places, as a permanent bar.
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * Nothing, structurally: it is new markup. What it replaces is a JOB the app
 * chip's menu was doing badly. That menu holds two unlike lists — the app's
 * own options (Workshop, discussion, feedback, terminal) and the platform's
 * places (Home, Discover, Challenges, Messages, Profile, Wallet, Validator,
 * Settings, Admin) — and #1443's charter put them together on the reasoning
 * that one control should name where you are and list everywhere you can go.
 *
 * Every host this shell is modelled on splits those two lists. WeChat,
 * Telegram, Discord, Slack and Teams all give a mini-app a flat menu of its
 * own options behind one button, AND keep a permanent bar of the host's
 * sections underneath; the menu's deeper rows link OUT to those sections,
 * filtered to the app you were in. This shell had the menu and no bar, so
 * there was nowhere to link out TO, and the platform's places sat in the
 * app's menu because there was no other list to put them in.
 *
 * This is that bar. The chip's menu becomes the app's menu in the same
 * change (see ../header/), and the rows that move here leave it.
 *
 * ── Why it is fixed, and not the last flex item in the body column ────
 *
 * The body is a 100dvh flex column, so a `flex: none` child at its end would
 * pin to the bottom of the screen — on the routes where that column is the
 * scroller. `html[data-browser-scroller]` is the routes where it is not: the
 * DOCUMENT scrolls there so browser toolbars can follow it (#1518), body
 * height goes `auto`, and a flex child at the end scrolls away with the page.
 * A tab bar that leaves the screen when you scroll is not a tab bar.
 *
 * So it is `position: fixed`, which is what public/css/app.css's
 * `.dev-ws-tabs` settled on for the same reason after `sticky` failed on a
 * real iOS PWA three times. Nothing in this element's ancestor chain
 * establishes a containing block — it is a direct child of <body>, above the
 * dialogs and outside every `backdrop-filter` wrapper in the shell — so it
 * needs no portal the way the Workshop's bar does.
 *
 * The space it covers is reserved in CSS, keyed off this element's own
 * `hidden` class (`body:has(#platform-tabs:not(.hidden))`), so the screens
 * reserve it exactly when it is there and nothing has to publish a second
 * fact for them to read. app.css carries that arithmetic and the reasoning.
 *
 * ── The two facts it reads, from two different stores ─────────────────
 *
 * WHETHER the bar is there comes from ../../lib/visibility-store.ts, with
 * the rest of the shell's chrome: `App.setChromeless()` and
 * `App._showOnlyScreen()` publish it, and it may be published BEFORE this
 * bundle has evaluated (public/js/app.js is a classic script and the React
 * entry is a deferred module), which the visibility store is the one that
 * survives.
 *
 * WHICH TAB is lit comes from ./nav-store.js through the bridge, like the
 * header title and the back button beside it, and so does WHOSE NAME the
 * fifth tab carries (#2760). Nothing writes either before hydration, so both
 * can be rendered directly.
 *
 * The visibility lands as `useHiddenClass` rather than a rendered
 * `className`, for the reason ../header/platform-header.tsx gives: this is
 * chrome, `PlatformUI` writes classes onto the shell's bars at runtime, and
 * a React-rendered class attribute would drop whatever the kit put there on
 * the next render. The class string below is a constant prop.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  ChatIcon,
  CogIcon,
  HomeIcon,
  SearchIcon,
  UserGroupIcon,
  UserIcon,
} from '@/components/ui/icons';

import { useClassToggle, useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  communityScopeStore, goToCommunity, hydrateCommunityScope, shortName, toggleSwitcher, warmCommunities,
  type CommunityInfo,
} from '../workshop/community-scope';
import { CommunitySwitcher } from '../workshop/community-switcher';
import { navStore } from './nav-store.js';
import { clearPeekTimer, enterPeek, leavePeek } from './rail-peek';
import { RecentsList } from './recents-list';
import { schedulePress, type PendingPress } from './tab-press';

/**
 * The five tabs, in order.
 *
 * WHY THESE FIVE, and why in this order: Home is the launcher, Discover is
 * everyone else's projects, Communities is the ones you are in, Messages is
 * the people and agents you talk to, and Me is your own account. Challenges,
 * Settings, Wallet, Validator and Admin are all reached from Me, which is
 * why five is enough — a sixth tab would be a section nobody visits daily.
 *
 * MESSAGES SITS IN THE MIDDLE, COMMUNITIES FOURTH. Communities took the
 * centre seat when it was renamed from "Workshop" (#3261), on the argument
 * that most visits would go through it. In use the thumb's first stop was
 * still the people and agents you talk to, so Messages has its centre seat
 * back and Communities sits beside you, fourth. Communities' key is still
 * `workshop`: the key names the screen (`#workshop-screen`) and the
 * declared checks select on `#platform-tab-workshop`, while the words a
 * person sees are Communities and `#communities` (AGENTS.md, "Communities
 * own projects"). Inside a project, "Workshop" is the build tab beside its
 * hub — the one place that word is shown now.
 *
 * Discover keeps the magnifier rather than taking a grid glyph: it is the
 * same row the app menu spelled `#switcher-row-discover` with a
 * <SearchIcon/>, and moving a destination should not also rename its glyph.
 */
const TABS = [
  {
    key: 'home' as const,
    label: 'Home',
    // A REAL PATH, not a fragment, and that is deliberate: Home is the only
    // one of the five that is a document address rather than a hash route,
    // so a cmd-click on it opens the launcher in a new tab the way the app
    // menu's Home row already does. The click handler below is what makes a
    // PLAIN click stay in this document.
    href: '/',
    Icon: HomeIcon,
  },
  { key: 'discover' as const, label: 'Discover', href: '#apps', Icon: SearchIcon },
  { key: 'messages' as const, label: 'Messages', href: '#messages', Icon: ChatIcon },
  { key: 'workshop' as const, label: 'Communities', href: '#communities', Icon: UserGroupIcon },
  // "Me" is the label only until somebody is signed in: from then on this tab
  // is named after them (#2760) — see tabLabel below.
  { key: 'me' as const, label: 'Me', href: '#profile', Icon: UserIcon },
];

/**
 * What a tab says, and what it is called (#2760).
 *
 * The fifth tab is the reader's own account, and "Me" was a word standing in
 * for a name the shell already has. So once somebody is signed in it carries
 * their USERNAME, on the phone's bar and the desktop rail alike — the owner
 * asked for both — the way the account row at the foot of Slack's, Discord's
 * and Linear's sidebars names you rather than a pronoun.
 *
 * "Me" STAYS THE PRERENDER. The document is built in Node with no session, so
 * the shipped markup can only say "Me", and a first client render that said
 * anything else would be React #418 on every route. `viewer` is null in the
 * nav store's INITIAL and is published from App.enterAuthed, which runs after
 * hydration, so the name arrives as an update — exactly how the lit tab does.
 *
 * THE ACCESSIBLE NAME KEEPS SAYING WHAT THE TAB IS. A bare username among
 * Home, Discover, Communities and Messages would be read out as a person rather
 * than a place, so the label names both, and it starts with the visible text
 * so a voice command that says what is on screen still finds it. Long names
 * are cut by app.css with an ellipsis; usernames are at most 32 characters
 * and never contain a space, so a clipped one is still recognisably yours.
 */
export function tabLabel(
  key: string,
  label: string,
  viewer: string | null,
): { text: string; ariaLabel: string | undefined } {
  if (key === 'me' && viewer) return { text: viewer, ariaLabel: `${viewer}, your profile` };
  return { text: label, ariaLabel: undefined };
}

/**
 * Home's plain click, routed in place.
 *
 * Copied in shape from `#switcher-row-home` in
 * ../app-context/app-context-sheet.tsx: let NavLink decide whether this was
 * a modified click (cmd/ctrl/middle/shift — "open it in a new tab", which
 * the href already does correctly), and otherwise stop the navigation and
 * hand it to the router. Without the guard a cmd-click both opened a tab
 * AND navigated this one.
 */
function onHomeClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // `viaTab`: a press on a tab swaps like one, even out of an app's Workshop,
  // where navigateHome otherwise shrinks the page into the app's tile (#2881).
  (window as unknown as { App?: { navigateHome?: (opts?: { viaTab?: boolean }) => void } })
    .App?.navigateHome?.({ viaTab: true });
}

/**
 * The Workshop tab's plain click: back to the app Workshop you left (#2776).
 *
 * The router decides (App.resumeWorkshopView, public/js/app.js): when this
 * device remembers an app's Workshop view and you are not already in one, it
 * takes you there and says so, and the href's navigation is stopped. Every
 * other time — nothing remembered, or already inside an app's Workshop,
 * where the tab pops to the selector as it always did — it answers false and
 * the href does exactly what it did before. A modified click is left alone,
 * as Home's is.
 */
function onWorkshopClick(event: React.MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  const app = (window as unknown as { App?: { resumeWorkshopView?: () => boolean } }).App;
  if (app?.resumeWorkshopView?.()) event.preventDefault();
}

/**
 * THE COMMUNITIES TAB'S FACE: the community it is on, or All communities.
 *
 * On the phone's bar, a square ring, the shape of an app's own tile, in the
 * tab's own ink, around either that community's tile (features/workshop/
 * community-scope.ts says which) or, on All communities, the tab's own
 * people glyph. The ring is what says the tab
 * can be switched: press it while it is lit and "Your communities" opens.
 * The desktop rail draws no ring (app.css): there the row goes back to All
 * communities, and the header's name is the switcher.
 *
 * All communities is THE PRERENDER: the scope arrives from localStorage and
 * app.js after the first paint, so the shipped markup and the first client
 * render are both this branch.
 */
function CommunityTabFace({ info }: { info: CommunityInfo | null }) {
  if (!info) {
    return (
      <span className="platform-tab-ring platform-tab-ring-all" aria-hidden="true">
        <UserGroupIcon className="platform-tab-glyph" aria-hidden="true" />
      </span>
    );
  }
  const app = { slug: info.slug, name: info.name, icon_url: info.iconUrl, icon_emoji: info.iconEmoji };
  return (
    <span className="platform-tab-ring" aria-hidden="true">
      <span className="app-icon-tile platform-tab-tile" data-icon={appIconKind(app as never)}>
        <AppIconContent app={app as never} />
      </span>
    </span>
  );
}

/**
 * The votes the tab's community is waiting on you for (All communities: all
 * of them), in the accent, because it asks for you. Only above zero, and
 * never in the prerender (the store starts empty). While it shows, app.css
 * hides the quiet unread-channels count beside it: one number per glyph.
 */
function VotesBadge({ count }: { count: number }) {
  if (!(count > 0)) return null;
  return (
    <span className="platform-tab-votes" aria-label={`${count} ${count === 1 ? 'vote' : 'votes'} waiting on you`}>
      {count > 99 ? '99+' : String(count)}
    </span>
  );
}

/**
 * The Messages tab's count — ALWAYS IN THE MARKUP, hidden until it has one.
 *
 * It renders unconditionally for the reason #notifications-badge in the
 * header does: the element is part of the shell's structural inventory
 * (tests/baselines/shell-markup.json), and an id that appears only once some
 * data has arrived is an id no declared check can select on a cold document.
 * The `hidden` class is therefore a CONSTANT in the class string — React
 * writes the attribute once at hydration and never again — and the toggle
 * goes through useHiddenClass, the same seam the shell uses everywhere a
 * class has to change without React owning it.
 *
 * The TEXT is React's, and it is empty at zero, so the prerender and the
 * first client render agree on an empty hidden span.
 */
function TabBadge({ count, id = 'platform-tabs-badge', label = 'Unread conversations' }: {
  count: number;
  id?: string;
  label?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useHiddenClass(ref, count <= 0);
  return (
    <span
      ref={ref}
      id={id}
      className="platform-tab-badge hidden"
      aria-label={label}
    >
      {count > 0 ? (count > 99 ? '99+' : String(count)) : ''}
    </span>
  );
}

/**
 * The rail, peeked back over an open app (#2718, desktop only).
 *
 * ── The problem, on a laptop ──────────────────────────────────────────
 *
 * An app covers the rail — "the app is the whole window" is what makes a
 * mini-app feel like a program rather than a page — and the way out is the ✕
 * in the header. That is right on a phone, where the ✕ is under your thumb.
 * On a laptop the pointer is already at the left edge half the time, and the
 * five places you might want are behind a control at the top-left corner and
 * a screen swap.
 *
 * So the rail comes BACK on hover, over the app, and going anywhere from it
 * leaves the app the way tapping a tab always does. WeChat's floating
 * capsule, a desktop OS's auto-hiding dock and Slack's own collapsed rail are
 * all the same move: the navigation is still there, it is just not spending
 * width while you are working.
 *
 * ── Why the peek is its own fact ──────────────────────────────────────
 *
 * It is NOT the bar's visibility. The router's answer is still "hidden" —
 * `App._syncPlatformTabs` said so, the screens reserve no band, and the app
 * is full width. The peek is a temporary overlay ON TOP of that answer, which
 * is why it is a separate field and why the CSS that reserves the band
 * excludes a peeking bar explicitly: a rail that reserved 224px on the way in
 * would reflow the app under the pointer.
 *
 * ── The grace period, and what it is for ──────────────────────────────
 *
 * The pointer has to cross a gap to get from the hot zone onto the rail, and
 * on the way back out it crosses the same gap. ./rail-peek.ts holds the delay
 * that covers it — as module state now, because #sidebar-toggle is a second
 * way in (#2764) and the toggle's leave and this bar's enter must share one
 * timer. It is cancelled on unmount so a screen swap cannot land a timer on a
 * bar that has since become the real one.
 */
function useRailPeek(peek: boolean) {
  useEffect(() => clearPeekTimer, []);
  return { enter: enterPeek, leave: peek ? leavePeek : clearPeekTimer };
}

/**
 * The lit tab's marker on the phone's bar (#2824): a blue pill behind the
 * tab you are on that SLIDES to the next one, borrowed from the Workshop's
 * own tab strip (`useTabMarker` in ../dev-board/workshop/workshop.tsx, and
 * `.dev-ws-tab-marker` in app.css). Colour alone was the only mark the bar
 * had, and at 11px on a phone that is easy to miss.
 *
 * THE SAME THREE RULES as the Workshop's, for the same reasons:
 *   - `null` until the first measurement, so the prerender and the first
 *     client render agree on a bare, unstyled span (nothing is lit until the
 *     router has spoken — see the hydration test in tests/nav-tab-bar.test.js);
 *   - only a SELECTION CHANGE slides. The first placement, and a re-measure
 *     of the tab you are already on (a rotation, the bar coming back from
 *     hidden, a desktop window narrowed to a phone), land instantly;
 *   - unchanged geometry keeps the previous box, so the ResizeObserver's
 *     delivery on `observe()` cannot cancel a slide that is still running.
 *
 * One addition: with nothing lit (the tab is `null`) the box goes back to
 * null and the marker hides, so the next tab to light lands rather than
 * sliding in from wherever the last one was.
 *
 * THE BOX HUGS THE TAB'S GLYPH AND LABEL, not the tab. The tab is the full
 * 56px cell edge to edge, which is right for the thumb and wrong for the
 * pill: a pill inset 4px from the cell was sized by the bar's width divided
 * by five, so a long label ("Workshop", "Messages") met its edges with a
 * pixel to spare and a short one ("Home") floated in a wide lozenge. The
 * pill is now what it holds plus the same padding on every tab — 5px over
 * the glyph, 8px either side, 3px under the label — with a floor so a
 * three-letter label still gets a pill rather than a capsule, and the tab
 * under it keeps the whole cell as its target. The desktop rail does not
 * use it at all — its rows carry a fill of their own, and app.css hides the
 * marker there.
 */
interface TabMarkerBox {
  x: number;
  y: number;
  w: number;
  h: number;
  slide: boolean;
}

/** The fallback when the tab's contents cannot be measured: the cell, inset. */
const MARKER_INSET = 4;
/** The pill's padding around the glyph and label, and its narrowest width. */
const MARKER_PAD = { top: 5, x: 8, bottom: 3 } as const;
const MARKER_MIN_W = 58;

/** A box relative to the tab it sits in, as getBoundingClientRect deltas. */
export type ContentRect = { left: number; top: number; width: number; height: number };

/**
 * The marker's box on the bar. `content` is the union of the tab's glyph and
 * label relative to the tab; without one (not measurable, or nothing laid
 * out inside) the box falls back to the cell inset 4px, the old geometry.
 * Integers, so a re-measure that lands on the same pixel keeps the previous
 * box (useTabMarker compares them) rather than restarting a slide.
 */
export function markerBoxFor(
  el: { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number },
  content?: ContentRect | null,
): Omit<TabMarkerBox, 'slide'> | null {
  // A bar that is not laid out (hidden, or the keyboard is up) has nothing to
  // say about where the tab is; keep the last box rather than collapse it.
  if (!(el.offsetWidth > 0) || !(el.offsetHeight > 0)) return null;
  if (!content || !(content.width > 0) || !(content.height > 0)) {
    return {
      x: el.offsetLeft + MARKER_INSET,
      y: el.offsetTop + MARKER_INSET,
      w: Math.max(0, el.offsetWidth - MARKER_INSET * 2),
      h: Math.max(0, el.offsetHeight - MARKER_INSET * 2),
    };
  }
  const w = Math.round(Math.max(MARKER_MIN_W, content.width + MARKER_PAD.x * 2));
  const h = Math.round(content.height + MARKER_PAD.top + MARKER_PAD.bottom);
  const centre = el.offsetLeft + content.left + content.width / 2;
  return {
    x: Math.round(centre - w / 2),
    y: Math.round(el.offsetTop + content.top - MARKER_PAD.top),
    w,
    h,
  };
}

/**
 * The union of a tab's glyph and label, relative to the tab. Null when
 * either is missing or not laid out, which sends markerBoxFor to its
 * fallback.
 */
export function tabContentRect(tab: HTMLElement): ContentRect | null {
  const parts = [tab.querySelector('.platform-tab-mark'), tab.querySelector('.platform-tab-label')]
    .map((node) => (node as HTMLElement | null)?.getBoundingClientRect?.())
    .filter((r): r is DOMRect => !!r && r.width > 0 && r.height > 0);
  if (parts.length < 2) return null;
  const base = tab.getBoundingClientRect();
  const left = Math.min(...parts.map((r) => r.left));
  const top = Math.min(...parts.map((r) => r.top));
  const right = Math.max(...parts.map((r) => r.right));
  const bottom = Math.max(...parts.map((r) => r.bottom));
  return { left: left - base.left, top: top - base.top, width: right - left, height: bottom - top };
}

/**
 * Run `fn` once the NEXT frame has been produced — two animation frames out,
 * not one (#3046). Returns a cancel.
 *
 * WHY THE SLIDE WAITS A FRAME. A tab press is a screen swap, and on the phone
 * the swap is synchronous (PlatformUI.phoneMotion makes every push/pop
 * 'none'): the router reveals the incoming screen in the same task that
 * lights the tab. So the first frame after the press is the EXPENSIVE one —
 * style, layout and paint of a whole screen that was `hidden` a moment ago.
 * A CSS transition's clock starts at the frame its style change is resolved
 * in, so a marker written in that frame had already spent the heavy frame's
 * duration by the time anything was painted, and on this curve (a steep
 * ease-out: two-thirds of the travel in the first third of the time) that is
 * most of the slide. What showed was the pill appearing half-way across and
 * settling — "missing the first half of the animation". The Workshop's own
 * strip runs the same hook on the same curve and looked right, because
 * switching ITS tab swaps no screen.
 *
 * One `requestAnimationFrame` is not enough: it fires at the START of that
 * heavy frame, before its style and layout, so a write there still lands in
 * it. The second fires once it has been produced. The label colour still
 * changes with the press (it keys off `aria-current`); only the pill's start
 * is held, by one frame nobody saw anyway.
 *
 * A PRESS ON THE BAR NO LONGER TAKES THIS PATH (#3259). Waiting out one
 * heavy frame was not enough on a phone: the swap is several long frames
 * (measured in the iOS simulator: the router's own task, then frames of 40
 * to 150ms while the new screen lays out and its data lands), so a slide
 * started two frames out still began inside one of them and showed from its
 * middle. So a press moves the pill FIRST, in the press's own task, and it is
 * the NAVIGATION that waits, until the slide is running on the compositor
 * where the swap cannot hold it (useTabMarker's `press`, schedulePress). This
 * path is still what a tab change the bar did not start takes (Back, a link,
 * a deep link).
 *
 * Without rAF (a test environment) it runs at once.
 */
export function afterNextFrame(
  fn: () => void,
  raf: ((cb: () => void) => number) | undefined
    = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
  caf: ((id: number) => void) | undefined
    = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined,
): () => void {
  if (!raf) {
    fn();
    return () => {};
  }
  let id = raf(() => {
    id = raf(() => {
      id = 0;
      fn();
    });
  });
  return () => {
    if (id && caf) caf(id);
    id = 0;
  };
}

/**
 * THE SLIDE ITSELF: the Workshop strip's duration and curve
 * (`.dev-ws-tab-marker`), run as a transform-only animation (#3259).
 *
 * It was a CSS transition of transform, width and height. The transform ran
 * on the compositor, but width and height are layout and ran on the main
 * thread, so once a press started the slide ahead of the screen swap, the
 * swap froze them mid-slide: the pill glided at the old tab's width (from
 * Communities to Me it ran past the screen's right edge in the iOS
 * simulator) and snapped to size when the swap let go. So the pill takes its
 * new size at once, and the slide is a FLIP: it starts scaled to the box it
 * is leaving and eases into the new one, all transform, all compositor.
 *
 * NO DELAY, deliberately. Measured on a test page in the iOS simulator with
 * the main thread blocked for 250ms two frames after the press: a translate
 * transition, a translate+scale transition and this animation all painted
 * 20%, 43%, 68%… straight through the block, while the same animation or
 * transition given a 34ms delay stood still and then appeared at the end.
 * A delay keeps WebKit from handing it to the compositor.
 */
export const MARKER_SLIDE = { duration: 260, easing: 'cubic-bezier(.32, .72, 0, 1)' } as const;

type Box = { x: number; y: number; w: number; h: number };

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The two transforms of a slide from `from` to `to`, for a marker laid out
 * at `to`'s size with `transform-origin: 0 0` (app.css).
 *
 * BOTH ENDS SPELL THE SAME FUNCTIONS, `translate() scale()`, the end with a
 * scale of 1, so the two interpolate function by function rather than as
 * matrices. That is the form measured running on the compositor through a
 * blocked main thread (MARKER_SLIDE); keep the lists matched when changing it.
 */
export function slideKeyframes(from: Box, to: Box): [string, string] {
  const sx = to.w > 0 ? round4(from.w / to.w) : 1;
  const sy = to.h > 0 ? round4(from.h / to.h) : 1;
  return [
    `translate(${from.x}px, ${from.y}px) scale(${sx}, ${sy})`,
    `translate(${to.x}px, ${to.y}px) scale(1, 1)`,
  ];
}

/**
 * Where a marker laid out at `laidOut`'s size is on screen under `transform`,
 * a computed `matrix(a, b, c, d, e, f)`. A press during a slide starts the
 * next one from where the pill IS, not from the box it was leaving.
 */
export function shownBox(laidOut: Box, transform: string): Box {
  const m = /^matrix\(([^)]+)\)$/.exec(String(transform || '').trim());
  const v = m ? m[1].split(',').map(Number) : [];
  if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) return laidOut;
  return { x: v[4], y: v[5], w: laidOut.w * v[0], h: laidOut.h * v[3] };
}

/** Reduced motion asks for none; unreadable answers that motion is welcome. */
function motionWelcome(): boolean {
  try {
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return true;
  }
}

/** A press slides only where a slide can show: a placed, drawn marker, with motion welcome. */
function canSlide(bar: HTMLElement): boolean {
  const marker = bar.querySelector<HTMLElement>('.platform-tabs-marker[data-marker-at]');
  // Unplaced (nothing lit yet), or `display: none` (the desktop rail).
  if (!marker || marker.getClientRects().length === 0) return false;
  return motionWelcome();
}

function useTabMarker(
  barRef: React.RefObject<HTMLElement | null>,
  tab: string | null,
): {
  box: TabMarkerBox | null;
  lit: string | null;
  markerRef: React.RefObject<HTMLSpanElement | null>;
  press: (el: HTMLElement, key: string, go: () => void) => boolean;
} {
  const [box, setBox] = useState<TabMarkerBox | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  // The box the marker was last laid out at, which the next slide leaves,
  // and the slide playing now, whose start a press waits for.
  const laidOut = useRef<TabMarkerBox | null>(null);
  const slide = useRef<Animation | null>(null);
  // THE TAB A PRESS LIT, until the router has answered it (#3259). The bar
  // answers a press at once, pill and label together, and the router's tab
  // takes over when it lands; `lit` is what the bar draws. Null at first,
  // so the first render is the prerender's.
  const [pressed, setPressed] = useState<string | null>(null);
  const lit = pressed ?? tab;
  // The press waiting for its route. A ref, not state: nothing renders from
  // it, and the callbacks that read it outlive the render they came from.
  const pending = useRef<PendingPress | null>(null);

  const place = (el: HTMLElement, selectionChanged: boolean) => {
    const next = markerBoxFor(el, tabContentRect(el));
    if (!next) return;
    setBox((prev) => {
      if (prev && prev.x === next.x && prev.y === next.y
        && prev.w === next.w && prev.h === next.h) return prev;
      return { ...next, slide: !!prev && selectionChanged };
    });
  };

  // The router lit the tab a press slid to: the press is answered, and the
  // bar is the router's again with nothing to move.
  useLayoutEffect(() => {
    if (!pending.current || pending.current.key !== tab) return;
    pending.current.cancel();
    pending.current = null;
    setPressed(null);
  }, [tab]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (!lit) {
      setBox(null);
      return;
    }
    // A slide waiting for the swap's frame to be painted (see afterNextFrame).
    let cancelSlide: (() => void) | null = null;
    const measure = (selectionChanged: boolean) => {
      const el = bar.querySelector<HTMLElement>('.platform-tab[aria-current="page"]');
      if (!el) return;
      place(el, selectionChanged);
    };
    // This run is the tab having changed; the observer's are layout moving.
    // The first placement lands now; a move from a tab already marked waits
    // out the screen swap's frame and then slides, re-measuring then so it
    // goes where the tab IS rather than where it was a frame ago. After a
    // press the pill is already there, so this lands on the same box.
    const hadBox = bar.querySelector('.platform-tabs-marker[data-marker-at]') !== null;
    if (hadBox) {
      cancelSlide = afterNextFrame(() => {
        cancelSlide = null;
        measure(true);
      });
    } else {
      measure(true);
    }
    if (typeof ResizeObserver === 'undefined') return () => cancelSlide?.();
    // The observer delivers once on observe(); while a slide is pending that
    // delivery must not land the marker at the new tab without it (the
    // pending slide re-measures anyway), so it waits for the slide too.
    const ro = new ResizeObserver(() => { if (!cancelSlide) measure(false); });
    ro.observe(bar);
    // The pill is sized by the lit tab's label now, and a label can change
    // width with the bar standing still (the Me tab takes the viewer's name
    // once it has loaded), so the label is watched as well.
    const label = bar.querySelector('.platform-tab[aria-current="page"] .platform-tab-label');
    if (label) ro.observe(label);
    return () => {
      ro.disconnect();
      cancelSlide?.();
    };
  }, [barRef, lit]);

  // THE SLIDE (MARKER_SLIDE). React has just laid the marker out at `box`;
  // a selection change plays it in from the box it left, or from wherever a
  // slide still running had got to. Anything else lands where it is: the
  // first placement, a re-measure, reduced motion, nothing lit.
  useLayoutEffect(() => {
    const el = markerRef.current;
    const prev = laidOut.current;
    laidOut.current = box;
    if (!el || typeof el.animate !== 'function') return;
    const running = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
    const from = prev && running.length ? shownBox(prev, getComputedStyle(el).transform) : prev;
    for (const animation of running) animation.cancel();
    slide.current = null;
    if (!box || !from || !box.slide || !motionWelcome()) return;
    const [start, end] = slideKeyframes(from, box);
    slide.current = el.animate([{ transform: start }, { transform: end }], {
      duration: MARKER_SLIDE.duration,
      easing: MARKER_SLIDE.easing,
    });
  }, [box]);

  // Unmounting abandons a press: its navigation and its settle timer.
  useEffect(() => () => {
    pending.current?.cancel();
    pending.current = null;
  }, []);

  /**
   * A press on another tab (#3259): light it and slide to it NOW, and
   * navigate once the slide is running (schedulePress). The slide is made in
   * the press's own task, and the swap's long frames begin only after it is
   * on the compositor, where they cannot hold it. `go` is the tab's own
   * navigation, run a few frames late.
   *
   * False when the pill cannot slide (the desktop rail, reduced motion,
   * nothing lit yet): the caller navigates as it always did, at once.
   *
   * If the router never lights `key`, the bar goes back to the tab it did
   * light after PRESS_SETTLE_MS rather than sitting on the wrong one.
   */
  const press = (el: HTMLElement, key: string, go: () => void): boolean => {
    const bar = barRef.current;
    if (!bar || !canSlide(bar)) return false;
    place(el, true);
    setPressed(key);
    // A second press before the first has navigated replaces it.
    schedulePress(pending, key, go, () => setPressed(null), () => slide.current?.ready ?? null);
    return true;
  };

  return { box, lit, markerRef, press };
}

/**
 * A tab's navigation, run by a press after the pill has started (#3259). The
 * same three roads the bar's clicks take at once: Home through the router
 * (onHomeClick), Communities back to the Workshop you left when there is one
 * (onWorkshopClick), and otherwise the tab's own href.
 */
function goToTab(key: string, href: string): void {
  const app = (window as unknown as {
    App?: { navigateHome?: (opts?: { viaTab?: boolean }) => void; resumeWorkshopView?: () => boolean };
  }).App;
  if (key === 'home' && app?.navigateHome) {
    app.navigateHome({ viaTab: true });
    return;
  }
  if (key === 'workshop' && app?.resumeWorkshopView?.()) return;
  window.location.assign(href);
}

export function PlatformTabs() {
  const barRef = useRef<HTMLElement | null>(null);
  // `true` is what the prerendered document ships: the bar is present and
  // visible, and the routes that hide it (an app, chromeless, the signed-out
  // shell) publish `false` once the router has run.
  const visible = useVisibility('platform-tabs', true);
  const { tab, messages, communities, screen, peek, peekOut, railOpen, viewer } = useStoreState(navStore);
  // THE COMMUNITY THE FOURTH TAB IS ON (../workshop/community-scope.ts). Read
  // from storage after the first paint, and every community's votes owed a
  // moment after sign-in, so the badge can say so before anybody opens the
  // switcher.
  const scope = useStoreState(communityScopeStore);
  useEffect(() => { hydrateCommunityScope(); }, []);
  useEffect(() => (viewer ? warmCommunities() : undefined), [viewer]);
  const scoped = scope.slug ? scope.info[scope.slug] || null : null;
  const votes = scope.slug ? Number(scoped?.needs) || 0 : Number(scope.totalNeeds) || 0;
  // TWO WAYS TO HAVE NO RAIL, and they are not the same fact. The ROUTE can
  // say there is none (an app, chromeless, signed out) and the VIEWER can
  // fold the one there is (../header/../nav/sidebar-toggle.tsx). The peek
  // brings it back over either.
  const collapsed = !visible || !railOpen;
  // A peek un-hides the bar without the router having changed its mind, so
  // the class it renders is the OR of the two and the overlay treatment is a
  // second class app.css keys the peeking case off.
  useHiddenClass(barRef, !visible && !peek);
  // …AND THE ROUTE'S OWN ANSWER RIDES BESIDE IT, because `hidden` alone can
  // no longer carry it. app.css decides whether the header's sidebar toggle
  // exists from `#platform-tabs:not(.hidden)`, and a peek over a running app
  // takes `hidden` off: pointing at the window's edge inside an app drew the
  // toggle into the app's strip, shoved ✕, the tile and the name 34px right,
  // and a press on it folded the docked rail behind the app. A rail that only
  // the peek is showing is not the route's, so there is nothing to fold.
  useClassToggle(barRef, 'platform-tabs-route-hidden', !visible);
  useClassToggle(barRef, 'platform-tabs-peek', collapsed && peek);
  // THE FADE OUT (#2795). The peek stays up for the length of the fade and
  // this class is what app.css turns into it; ./rail-peek.ts times both.
  useClassToggle(barRef, 'platform-tabs-peek-out', collapsed && peek && peekOut);
  // FOLDED IS A CLASS, NOT A `hidden`, and that is the whole safety of it: a
  // phone's bar is at the FOOT of the screen and is the only navigation there
  // is, so folding must never reach it. app.css acts on this class inside
  // `@media (min-width: 768px)` and nowhere else, which means a desktop
  // window narrowed to a phone gets its bar back without this store having to
  // watch the viewport.
  useClassToggle(barRef, 'platform-tabs-folded', !railOpen);
  const { enter, leave } = useRailPeek(peek);
  const { box: marker, lit, markerRef, press } = useTabMarker(barRef, tab);
  // A plain press on another tab lights it and slides the pill first, and
  // navigates a frame later (useTabMarker's `press`, #3259). A modified click
  // stays the browser's, a second press on a tab still waiting for its route
  // adds nothing, and a press the pill cannot slide for navigates at once,
  // the way every press did before.
  const onTabClick = (event: React.MouseEvent<HTMLAnchorElement>, key: string, href: string) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (key === lit && lit !== tab) {
      event.preventDefault();
      return;
    }
    // THE LIT COMMUNITIES TAB. On a phone it opens "Your communities"
    // (../workshop/community-switcher.tsx) rather than popping to the list:
    // the tab is a community now, and pressing it again is how you change
    // which. On the desktop rail it goes back to All communities, the list,
    // as a sidebar row does; the header's name is the switcher there.
    if (key === 'workshop' && lit === 'workshop' && tab === 'workshop') {
      let wide = false;
      try { wide = window.matchMedia('(min-width: 768px)').matches; } catch { wide = false; }
      if (!wide) {
        event.preventDefault();
        toggleSwitcher('tab', event.currentTarget);
        return;
      }
      if (scope.slug) {
        event.preventDefault();
        goToCommunity(null);
        return;
      }
    }
    if (key !== lit && press(event.currentTarget, key, () => goToTab(key, href))) {
      event.preventDefault();
      return;
    }
    const now = key === 'home' ? onHomeClick : key === 'workshop' ? onWorkshopClick : undefined;
    now?.(event);
  };

  return (
    <>
      {/*
          THE HOT ZONE. A strip at the window's left edge, and the only thing
          that can start a peek. It renders wherever there is no rail to point
          at — inside an app, or with the rail folded by hand — and app.css
          hides it below the desktop breakpoint, because a phone has no
          pointer to hover with and a hidden touch target at the screen edge
          would eat swipes.

          NOT `collapsed`, and not a bare `screen === 'app-view'` either.
          `collapsed` is also true on the chromeless and signed-out shells,
          where there is no rail behind the edge to bring back and a strip
          that peeked one in would be conjuring navigation out of nothing.
          And the app view is TWO screens now (#2718 review): on its Workshop
          the rail is UP, and this strip is `z-index: 39` against the rail's
          30 — an invisible 18px column down the left edge of the tabs,
          swallowing the press meant for the one under the pointer.

          So: the app view WITH ITS RAIL DOWN, which is the running app, or a
          rail the viewer folded anywhere. A folded rail is the running app's
          arrangement reached another way and the way back has to be the same
          one, or the toggle is a door that only opens; `!railOpen` implies a
          rail existed, because the toggle renders only where one does.
      */}
      {(screen === 'app-view' && !visible) || !railOpen ? (
        <div
          id="platform-rail-peek"
          className="platform-rail-peek"
          aria-hidden="true"
          onMouseEnter={enter}
          onMouseLeave={leave}
        />
      ) : null}
      <nav
        ref={barRef}
        id="platform-tabs"
        className="platform-tabs"
        aria-label="Sections"
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
      {/*
          THE LIT TAB'S MARKER (#2824). Before the tabs so it paints behind
          them (app.css raises each tab one step), `aria-hidden` because
          `aria-current` already says which tab is lit, and bare until
          measured — see useTabMarker. `data-marker-at` is what makes it
          visible. The style is where it rests; the slide there is an
          animation useTabMarker plays over it (MARKER_SLIDE).
      */}
      <span
        ref={markerRef}
        className="platform-tabs-marker"
        aria-hidden="true"
        {...(marker ? { 'data-marker-at': '' } : {})}
        style={marker ? {
          transform: `translate(${marker.x}px, ${marker.y}px)`,
          width: `${marker.w}px`,
          height: `${marker.h}px`,
        } : undefined}
      />
      {TABS.flatMap(({ key, label, href, Icon }) => [
        // RECENTS SIT BETWEEN THE SECTIONS AND YOU (#2802): after the last
        // section (Communities), before Me at the rail's foot, which is where
        // the Resume strip it replaces sat, so the four destinations stay one
        // run. Desktop only; app.css keeps it off the phone's bar.
        key === 'me' ? <RecentsList key="recents" /> : null,
        <a
          key={key}
          id={`platform-tab-${key}`}
          className="platform-tab"
          href={href}
          data-tab={key}
          // `aria-current="page"` and nothing else marks the active tab:
          // it is what a screen reader announces and what the declared
          // checks select on, and it costs no second attribute to keep in
          // step with. The colour comes from app.css keying off it. It is the
          // router's tab, except for the moment between a press and its route
          // landing, when it is the tab pressed (useTabMarker, #3259).
          aria-current={lit === key ? 'page' : undefined}
          aria-label={key === 'workshop' && scoped ? `${scoped.name}, your communities` : tabLabel(key, label, viewer).ariaLabel}
          onClick={(event) => onTabClick(event, key, href)}
        >
          <span className="platform-tab-mark">
            {key === 'workshop'
              ? <CommunityTabFace info={scoped} />
              : <Icon className="platform-tab-glyph" aria-hidden="true" />}
            {/*
                THE SECOND BADGE IN THE SHELL, and the first one that is not
                the bell's. #1443 argued the platform should carry exactly
                one count, on #notifications-badge, on the grounds that an
                unread message IS a notification and a menu is where you say
                where you are going, not where you learn something happened.
                That argument holds for a MENU ROW. A tab is a place you can
                see without opening anything, and a bar whose Messages tab
                cannot say "there is something here" makes the bell the only
                way to find out — which puts a conversation behind the same
                sheet the bar exists to get things out of.

                It counts CONVERSATIONS with something unread, not messages,
                because the number has to mean "how many things to open".
                Rendered only above zero, so the prerender (INITIAL is 0)
                and the first client render agree with no badge at all.

                AND IT IS THE QUIET ONE (#2912). Unread messages are counted
                in the bell too, so this one is grey rather than the bell's
                red: on the phone's bar a grey disc on the glyph's corner, on
                the desktop rail a grey pill at the row's far end. It stays
                HERE in the markup for both; app.css moves it on the rail by
                dissolving this wrapper, so the phone keeps its anchor and a
                declared check keeps finding it inside the Messages tab.
            */}
            {key === 'messages' ? <TabBadge count={messages} /> : null}
            {/*
                THE CHANNELS' COUNT, on Communities. A project's channel lives
                on its hub now, not in Messages, so "something was said in a
                room you are in" is counted where the room is: how many of
                your communities' channels have unread messages (#general is
                Homeroom's). The same quiet grey disc, for the same reason.
            */}
            {key === 'workshop' ? (
              <TabBadge count={communities} id="platform-tabs-badge-communities" label="Channels with unread messages" />
            ) : null}
            {key === 'workshop' ? <VotesBadge count={votes} /> : null}
          </span>
          <span className="platform-tab-label">
            {key === 'workshop' && scoped ? shortName(scoped.name) : tabLabel(key, label, viewer).text}
          </span>
        </a>,
      ])}
      {/*
          SETTINGS, ONE CLICK FROM THE RAIL'S FOOT (#3120). A cog beside the
          account row, the way Slack, Discord and Linear put the settings
          control next to you rather than inside a page about you. Before
          this, Settings on a desktop was Me → scroll → the Settings row.

          DESKTOP ONLY. app.css draws it inside `@media (min-width: 768px)`
          and nowhere else: the phone's bar is five equal cells and stays
          that way, and Settings stays a row of the Profile screen there.

          AFTER Me in the markup, so the reading order is "you, then your
          settings" and the declared check's sibling chain that ENDS at
          #platform-tab-me is untouched. It is not a `.platform-tab` (the
          phone's marker and the bar's grid count those), and it lights on
          the Settings screen itself — the Me row stays lit too, because
          Settings still belongs to the Me section on both bars.
      */}
      <a
        id="platform-rail-settings"
        className="platform-rail-settings"
        href="#settings"
        aria-label="Settings"
        title="Settings"
        aria-current={screen === 'settings-screen' ? 'page' : undefined}
      >
        <CogIcon className="platform-rail-settings-glyph" aria-hidden="true" />
      </a>
      </nav>
      <CommunitySwitcher />
    </>
  );
}
