/**
 * "Skip to navigation" — the first thing a keyboard reaches on every screen
 * (QA 2026-09-24 Q18).
 *
 * The rail (#platform-tabs) is drawn on the left but comes AFTER the screens
 * in the document, because it is not part of any of them (see Shell.tsx), so
 * Tab went header, then the whole screen, then the sections: 35 to 43
 * presses from the top of Home to its own Home tab. This link sits first in
 * <body>, invisible until it has focus, and moves focus to the rail's first
 * tab.
 *
 * It is a link to `#platform-tabs` for what it announces, but the click is
 * handled here: the platform routes on the fragment, so letting the browser
 * follow it would navigate to a screen called "platform-tabs".
 *
 * It carries no id (nothing looks it up), so the shell's id inventory is
 * unchanged. It renders exactly the same markup in the prerender and the
 * first client render (`useVisibility`'s initial value is the prerender's),
 * and hides only once the router says the current screen has no rail — an
 * app running full width, the chromeless and signed-out shells.
 */

import type { MouseEvent } from 'react';

import { useVisibility } from '../../lib/visibility-store';

const CLS = 'sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-[100] '
  + 'focus:rounded-full focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-lg '
  + 'focus:bg-white focus:text-violet-700 focus:ring-2 focus:ring-violet-500 '
  + 'dark:focus:bg-zinc-900 dark:focus:text-violet-300';

function skipToNavigation(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const nav = document.getElementById('platform-tabs');
  const tabs = nav ? Array.from(nav.querySelectorAll<HTMLElement>('a.platform-tab')) : [];
  // A rail folded away on the desktop draws no tabs; the control that brings
  // it back is the next best place to land.
  const target = tabs.find((tab) => tab.getClientRects().length > 0)
    || document.getElementById('sidebar-toggle');
  target?.focus();
}

export function SkipToNavigation() {
  const railOnRoute = useVisibility('platform-tabs', true);
  return (
    <a href="#platform-tabs" className={CLS} hidden={!railOnRoute} onClick={skipToNavigation}>
      Skip to navigation
    </a>
  );
}
