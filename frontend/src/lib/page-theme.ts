/**
 * The page's look, as React sees it: `true` while <html> is drawn dark.
 *
 * It follows the theme module's own change signal (`window.Theme.onChange`),
 * which fires after the new theme is on <html> — an explicit Light/Dark pick,
 * an OS flip while the theme is System, another tab's write — so anything
 * picked in one mode redraws in the other without a reload. One listener on
 * `window.Theme` serves every component mounted.
 */

import { useSyncExternalStore } from 'react';

const readers = new Set<() => void>();
let heard = false;

function subscribe(onChange: () => void): () => void {
  readers.add(onChange);
  if (!heard && typeof window !== 'undefined') {
    heard = true;
    window.Theme?.onChange?.(() => { for (const reader of [...readers]) reader(); });
  }
  return () => { readers.delete(onChange); };
}

const isDark = (): boolean => typeof document !== 'undefined'
  && document.documentElement.classList.contains('dark');
const notDark = (): boolean => false;

/** Whether the page is drawn dark now; redraws when the mode changes. */
export function usePageDark(): boolean {
  return useSyncExternalStore(subscribe, isDark, notDark);
}
