/**
 * `#app-switcher-btn` — the header's left-hand control: your avatar, the name
 * of the app you are in, and a chevron (#1436).
 *
 * ── What it replaced, and what it did NOT ──────────────────────────────
 *
 * The hamburger. Not the drawer behind it — that surface is unchanged and
 * still owned by ../header/header-menu-controller.js, with its kit `panel`
 * adoption, ghost-click guard, nav-arm window and dismiss waiters intact. What
 * changed is the TRIGGER and the drawer's contents.
 *
 * A hamburger is an unlabeled control with no primary action, which is why
 * everything with nowhere else to go ended up behind it. This chip is labeled
 * with the app you are in and its primary action is switching, so the menu has
 * a spine: it answers "where am I / where else can I go", with your account as
 * a terminal group at the bottom. The rule that keeps it from decaying back
 * into a hamburger is in the menu, not here.
 *
 * ── It is on EVERY screen, and it is the header's only label ───────────
 *
 * The first cut showed it only inside an app, and hid it on home, Messages,
 * Settings and the rest, where `#header-title` carried the name instead. Two
 * different header shapes for one product: on some screens a tappable chip,
 * on others a dead string, with no rule a person could learn. It is the same
 * control everywhere now, and the thing it names is wherever you are.
 *
 * The label comes from `App.setHeaderTitle` through
 * ./switcher-controller.js's `setTitle`. That function is the single choke
 * point every screen entry already funnels through, and the same string it
 * puts in `document.title` — so the chip cannot drift from the browser tab,
 * and it needs no second router to follow navigation. It reads "Messages" on
 * Messages and "Cool App" inside Cool App because setHeaderTitle is already
 * called with each.
 *
 * `#header-title` is therefore HIDDEN at all times (see
 * ../header/platform-header.tsx). It stays in the document and keeps being
 * written: declared checks resolve it, and it is what `document.title` is
 * derived from. What it no longer does is put a second name in the bar.
 *
 * ── The avatar is legacy-written, deliberately ─────────────────────────
 *
 * `#switcher-avatar` / `#switcher-avatar-glyph` are a hidden `<img>` and a
 * glyph, exactly like the drawer's Profile row, and `App.applyUserAvatar()`
 * swaps which one is `hidden` on sign-in and after the profile editor saves.
 * Both className strings are therefore CONSTANT props — rendered once at
 * hydration and never again — because a React re-render would drop the class
 * app.js just wrote. The `<img>` gets no `src` until there is one, so a viewer
 * with no picture never issues a request.
 */

import { ChevronDownIcon, UserIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { switcherStore } from './switcher-store.js';

const CHIP_CLASS =
  'relative inline-flex items-center gap-1.5 h-7 pl-1 pr-1.5 rounded-full '
  + 'bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 '
  + 'text-zinc-900 dark:text-zinc-100 text-xs font-medium '
  + 'transition-colors un-touch-target max-w-[13rem]';

interface HeaderMenuBridge {
  isPresenting?: () => boolean;
  open?: () => void;
  close?: () => void;
}

function drawer(): HeaderMenuBridge | undefined {
  return (window as unknown as { HeaderMenu?: HeaderMenuBridge }).HeaderMenu;
}

export function SwitcherChip() {
  const { title } = useStoreState(switcherStore);

  // The chip's width changes with the name in it, and the header measures its
  // left group. The ResizeObserver catches that a frame later on its own; this
  // is the explicit hook, so nothing visibly jumps on the frame you navigate.
  useIsomorphicLayoutEffect(() => {
    (window as unknown as { HeaderLayout?: { refresh?: () => void } })
      .HeaderLayout?.refresh?.();
  }, [title]);

  // Toggle rather than open: the drawer's controller exposes `isPresenting()`
  // for exactly this (the Improve panel already asks it before presenting), and
  // a trigger that only ever opens leaves a tap on the chip doing nothing while
  // the menu it opened is on screen.
  const toggle = () => {
    const menu = drawer();
    if (menu?.isPresenting?.()) menu.close?.();
    else menu?.open?.();
  };

  // A fallback for the instant before the first setHeaderTitle lands — and for
  // the prerender, which has no navigation behind it. An empty chip would read
  // as a broken control; a generic word reads as a menu.
  const label = title || 'Menu';

  return (
    <button
      id="app-switcher-btn"
      type="button"
      className={CHIP_CLASS}
      aria-label={`Menu — currently ${label}`}
      aria-haspopup="menu"
      onClick={toggle}
    >
      {/* Constant className on both: App.applyUserAvatar() owns which is
          hidden. See the header comment. */}
      <UserIcon
        id="switcher-avatar-glyph"
        className="w-5 h-5 shrink-0 rounded-full text-zinc-500 dark:text-zinc-400"
      />
      <img
        id="switcher-avatar"
        alt=""
        className="hidden w-5 h-5 shrink-0 rounded-full object-cover bg-zinc-200 dark:bg-zinc-700"
      />
      <span id="app-switcher-name" className="truncate">
        {label}
      </span>
      <ChevronDownIcon className="w-3.5 h-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </button>
  );
}
