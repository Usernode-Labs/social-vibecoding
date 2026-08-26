/**
 * Loads the app list behind the switcher chip (#1436).
 *
 * ── Borrowed, not re-fetched ───────────────────────────────────────────
 *
 * `Home._apps` is the cached, visibility-filtered `/api/apps` payload the home
 * grid already loads, and it is the same list this menu wants. Reading it
 * costs nothing on the common path — you have almost always been to home
 * before opening the switcher — and the fetch below is the cold-boot case
 * only: a deep link straight into an app, where home has never rendered.
 *
 * The fetch is deliberately the SAME url and the same `?demo=1` forwarding
 * home uses, so staging shows the same apps in both places rather than the
 * switcher quietly disagreeing with the grid behind it.
 *
 * ── Loaded on OPEN, never on render ────────────────────────────────────
 *
 * `sv:drawer-open` is the drawer's own announcement, dispatched once above
 * its touch/desktop fork. Listening to it rather than being called from the
 * chip means the list refreshes however the surface was opened — the chip, a
 * `?shot=menu` deep link, or a keyboard path — and it keeps the store's
 * initial state empty, which is what the SSG prerender emits and therefore
 * what hydration expects.
 */

import { switcherStore } from './switcher-store.js';

/** Mirrors Home's own demo-mode forwarding so the two lists cannot disagree. */
function demoQuery() {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/** Only the fields the menu renders — an app row is a name and a slug. */
function shape(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.slug === 'string' && a.slug)
    .map((a) => ({
      slug: a.slug,
      name: typeof a.name === 'string' && a.name ? a.name : a.slug,
      status: a.status || null,
    }));
}

export const AppSwitcher = {
  /**
   * The chip's label. Called from `App.setHeaderTitle`, which is the single
   * choke point every screen entry already funnels through — so the chip
   * follows navigation without a second router to keep in step, and says
   * exactly what the browser tab says.
   */
  setTitle(text) {
    const title = typeof text === 'string' ? text : '';
    if (switcherStore.get().title === title) return;
    switcherStore.set({ title });
  },

  async loadApps() {
    const cached = shape(/** @type {any} */ (window).Home?._apps);
    if (cached.length) {
      switcherStore.set({ apps: cached, loading: false, loaded: true });
      return cached;
    }
    if (switcherStore.get().loading) return switcherStore.get().apps;
    switcherStore.set({ loading: true });
    try {
      const res = await fetch(`/api/apps${demoQuery()}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`/api/apps ${res.status}`);
      const body = await res.json();
      const apps = shape(Array.isArray(body) ? body : body && body.apps);
      switcherStore.set({ apps, loading: false, loaded: true });
      return apps;
    } catch {
      // A switcher that cannot list apps still has to open — its Home,
      // Discover and account rows are the reason most people tap it. Mark the
      // load resolved so the menu shows its empty state rather than a spinner
      // that never ends.
      switcherStore.set({ loading: false, loaded: true });
      return switcherStore.get().apps;
    }
  },

  /**
   * Wired from the island's layout effect, so it is listening before
   * DOMContentLoaded — the same window every other boot hook in this feature
   * uses.
   */
  init() {
    if (AppSwitcher._bound) return;
    AppSwitcher._bound = true;
    document.addEventListener('sv:drawer-open', () => {
      AppSwitcher.loadApps();
    });
  },

  _bound: false,
};

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).AppSwitcher = AppSwitcher;
}
