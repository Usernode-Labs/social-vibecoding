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
 * ── Why the label is not this component's state ────────────────────────
 *
 * It reads ../improve/improve-store.js, the same store `ImproveButton` and
 * `ImproveViewToggle` read. `Improve.publishTarget()` (an open app) and
 * `Home.publishImproveTarget()` (the platform's own row, while home is on
 * screen) already publish `target`, `slug` and `name` there, and
 * `#improve-target-name` renders that same `name` in the panel's header. A
 * second store fed by those same two callers is how a header label and a panel
 * header start disagreeing about which app you are looking at.
 *
 * It also means the chip inherits the Improve button's show/hide lifecycle
 * exactly: present wherever there is a target, absent everywhere else. That
 * matters for the header's layout — see the note on `#header-title` below.
 *
 * ── The chip and the title are mutually exclusive ──────────────────────
 *
 * `#header-title` names the SCREEN (Settings, Profile, Messages…), which is
 * still the right thing on a screen that is not an app. The chip names the
 * APP. Showing both would put two names in one bar, so the chip renders
 * exactly where a target exists and ../header/platform-header.tsx hides the
 * title on the same condition.
 *
 * That is also what keeps use-header-layout.ts's centering measurement honest.
 * It decides between a viewport-centred and a flow-positioned title by
 * measuring the left group's inner edge against the right group; a variable
 * width left group would normally make that harder, but when the chip is
 * showing there is no title to centre, and when there is a title the chip is
 * gone and the left group is back to its fixed 20px.
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
import { improveStore } from '../improve/improve-store.js';

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
  // `target !== 'platform'` rather than merely `target`: #1406 republishes the
  // PLATFORM's own row on every non-home screen so the Improve button survives
  // onto settings, profile and messages. A chip that rendered on that would
  // label Settings with the platform's name and hide the screen's own title —
  // see the matching note in ../header/platform-header.tsx.
  const { target, name } = useStoreState(improveStore);
  const inApp = Boolean(target) && target !== 'platform';

  // The chip materially changes the header's LEFT group width, which is one of
  // the two inputs to the title's centred-vs-flow decision. The group's
  // ResizeObserver catches it a frame later on its own; this is the explicit
  // hook, so nothing visibly jumps on the frame an app opens or closes.
  useIsomorphicLayoutEffect(() => {
    (window as unknown as { HeaderLayout?: { refresh?: () => void } })
      .HeaderLayout?.refresh?.();
  }, [inApp]);

  // Toggle rather than open: the drawer's controller exposes `isPresenting()`
  // for exactly this (the Improve panel already asks it before presenting), and
  // a trigger that only ever opens leaves a tap on the chip doing nothing while
  // the menu it opened is on screen.
  const toggle = () => {
    const menu = drawer();
    if (menu?.isPresenting?.()) menu.close?.();
    else menu?.open?.();
  };

  // The platform's own row has a name like any other app, so there is no
  // special case here — only a fallback for the instant before a publisher has
  // run, where an empty chip would be worse than a generic word.
  const label = name || 'Apps';

  return (
    <button
      id="app-switcher-btn"
      type="button"
      className={inApp ? CHIP_CLASS : `hidden ${CHIP_CLASS}`}
      aria-label={`Switch app — currently ${label}`}
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
