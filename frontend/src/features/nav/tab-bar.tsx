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
 * header title and the back button beside it. Nothing writes it before
 * hydration, so it can be rendered directly.
 *
 * The visibility lands as `useHiddenClass` rather than a rendered
 * `className`, for the reason ../header/platform-header.tsx gives: this is
 * chrome, `PlatformUI` writes classes onto the shell's bars at runtime, and
 * a React-rendered class attribute would drop whatever the kit put there on
 * the next render. The class string below is a constant prop.
 */

import { useCallback, useEffect, useRef } from 'react';

import {
  BoardIcon,
  ChatIcon,
  HomeIcon,
  SearchIcon,
  UserIcon,
} from '@/components/ui/icons';

import { useClassToggle, useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { navStore } from './nav-store.js';

/**
 * The five tabs, in order.
 *
 * WHY THESE FIVE, and why in this order: the bar reads left to right as
 * distance from you. Home is the launcher, Discover is everyone else's apps,
 * Messages and Workshop are the two things that can be WAITING for you (the
 * conversation and the change), and Me is your own account. Challenges,
 * Settings, Wallet, Validator and Admin are all reached from Me, which is
 * why five is enough — a sixth tab would be a section nobody visits daily.
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
  { key: 'workshop' as const, label: 'Workshop', href: '#workshop', Icon: BoardIcon },
  { key: 'me' as const, label: 'Me', href: '#profile', Icon: UserIcon },
];

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
  (window as unknown as { App?: { navigateHome?: () => void } }).App?.navigateHome?.();
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
function TabBadge({ count }: { count: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useHiddenClass(ref, count <= 0);
  return (
    <span
      ref={ref}
      id="platform-tabs-badge"
      className="platform-tab-badge hidden"
      aria-label="Unread conversations"
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
 * on the way back out it crosses the same gap. Un-peeking the moment either
 * element is left makes the rail flicker away under a pointer that is on its
 * way to it. A short delay, cancelled by entering either one, is the whole
 * fix — and it is cancelled on unmount so a screen swap cannot land a timer
 * on a bar that has since become the real one.
 */
function useRailPeek(peek: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => clear, [clear]);
  const enter = useCallback(() => {
    clear();
    if (!navStore.get().peek) navStore.set({ peek: true });
  }, [clear]);
  const leave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      navStore.set({ peek: false });
    }, 280);
  }, [clear]);
  return { enter, leave: peek ? leave : clear };
}

export function PlatformTabs() {
  const barRef = useRef<HTMLElement | null>(null);
  // `true` is what the prerendered document ships: the bar is present and
  // visible, and the routes that hide it (an app, chromeless, the signed-out
  // shell) publish `false` once the router has run.
  const visible = useVisibility('platform-tabs', true);
  const { tab, messages, screen, peek } = useStoreState(navStore);
  // A peek un-hides the bar without the router having changed its mind, so
  // the class it renders is the OR of the two and the overlay treatment is a
  // second class app.css keys the peeking case off.
  useHiddenClass(barRef, !visible && !peek);
  useClassToggle(barRef, 'platform-tabs-peek', !visible && peek);
  const { enter, leave } = useRailPeek(peek);

  return (
    <>
      {/*
          THE HOT ZONE. A strip at the window's left edge, and the only thing
          that can start a peek. It renders only inside an app — everywhere
          else the rail is already there — and app.css hides it below the
          desktop breakpoint, because a phone has no pointer to hover with and
          a hidden touch target at the screen edge would eat swipes.
      */}
      {screen === 'app-view' ? (
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
      {TABS.map(({ key, label, href, Icon }) => (
        <a
          key={key}
          id={`platform-tab-${key}`}
          className="platform-tab"
          href={href}
          data-tab={key}
          // `aria-current="page"` and nothing else marks the active tab:
          // it is what a screen reader announces and what the declared
          // checks select on, and it costs no second attribute to keep in
          // step with. The colour comes from app.css keying off it.
          aria-current={tab === key ? 'page' : undefined}
          onClick={key === 'home' ? onHomeClick : undefined}
        >
          <span className="platform-tab-mark">
            <Icon className="platform-tab-glyph" aria-hidden="true" />
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
            */}
            {key === 'messages' ? <TabBadge count={messages} /> : null}
          </span>
          <span className="platform-tab-label">{label}</span>
        </a>
      ))}
      </nav>
    </>
  );
}
