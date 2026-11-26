/**
 * ON A MEDIUM DISPLAY THE MENU STARTS AS ITS STRIP (asked 20 Nov 2026).
 *
 * From 768px the menu is a sidebar, 244px wide. Between 768px and 1024px
 * that is a third of the window, so there it starts folded to its strip of
 * icons and logos (app.css, "FOLDED, THE MENU IS A STRIP"), and it unfolds
 * again when the window grows past 1024px. The fold button still turns it
 * over at either size: this only sets where it starts, and where it goes
 * when the window crosses the line.
 *
 * Called from the tab bar's own effect, so the first render is the
 * prerendered document's (open) and nothing mismatches at hydration.
 */
import { navStore } from './nav-store.js';

/** The widths at which the menu starts as its strip. */
export const RAIL_MEDIUM = '(min-width: 768px) and (max-width: 1023.98px)';

/** Follow the display's size; answers the function that stops following. */
export function followDisplaySize(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const medium = window.matchMedia(RAIL_MEDIUM);
  const apply = () => {
    // A phone has no fold: its bar is the bottom bar, whatever this says.
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    const open = !medium.matches;
    if (navStore.get().railOpen !== open) navStore.set({ railOpen: open, peek: false, peekOut: false });
  };
  apply();
  medium.addEventListener?.('change', apply);
  return () => medium.removeEventListener?.('change', apply);
}
