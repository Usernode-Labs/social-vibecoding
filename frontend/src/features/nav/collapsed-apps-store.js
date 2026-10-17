/**
 * The apps closed on purpose, folded in the desktop rail's Active section
 * (#3618).
 *
 * The ✕ in a running app's header is a close ON PURPOSE: the app is done
 * being looked at, even though its frame keeps running and its Active row
 * stays. Until now the row kept looking exactly like an app you stepped out
 * of, which is the wrong answer to "which of these do I still want on
 * screen". So the close folds the row up into its icon and a Resume pill —
 * same place in Active, no name, no dot — and every way back on screen
 * unfolds it again.
 *
 * WHO WRITES. Closing is a fact only the legacy router knows: the ✕ runs
 * `App.closeApp()` in public/js/app.js, and the rail is React. The writes
 * cross the classic-script bridge — `window.UsernodeReact.nav.collapseApp` /
 * `.expandApp`, published by ./mount.ts beside `park` — and the reads are
 * RecentsList's, through `useStoreState` here. Being on screen is the
 * router's answer too: `_syncParkedApp`'s inApp branch is the one place that
 * already decides "the app is on screen" on every screen decision, so it
 * publishes the expand and any way back (the folded control itself, another
 * row, a Home tile, a deep link, Back) unfolds the row.
 *
 * WHY NO STORAGE. Session-only, on purpose: the kept frames a folded row
 * stands for do not survive a reload, so there is nothing worth remembering
 * across one — after a reload nothing is running, and Active is empty anyway.
 * INITIAL is empty, so the prerendered document and the first render agree
 * (nothing here may be called during an initial render; the store has no
 * storage read at all).
 */

import { createStore } from '../../lib/plain-store.js';

/** @type {{ slugs: string[] }} */
const INITIAL = { slugs: [] };

export const collapsedAppsStore = createStore(INITIAL);

/**
 * Fold `slug`'s Active row: the ✕ closed the app on purpose. Collapsing an
 * already-folded app keeps one entry.
 *
 * @param {string} slug
 */
export function collapseApp(slug) {
  if (typeof slug !== 'string' || !slug) return;
  const current = collapsedAppsStore.get().slugs;
  if (current.includes(slug)) return;
  collapsedAppsStore.set({ slugs: [...current, slug] });
}

/**
 * Unfold `slug`'s row: the app is on screen again, by whatever way back. A
 * no-op when it was not folded.
 *
 * @param {string} slug
 */
export function expandApp(slug) {
  if (typeof slug !== 'string' || !slug) return;
  const current = collapsedAppsStore.get().slugs;
  if (!current.includes(slug)) return;
  collapsedAppsStore.set({ slugs: current.filter((s) => s !== slug) });
}

/** A different account (or none) folds nothing over: empty the set. */
export function resetCollapsedApps() {
  collapsedAppsStore.set({ slugs: [] });
}