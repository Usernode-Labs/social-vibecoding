/**
 * The drawer's "Your apps" section state (Streamlined Concept).
 *
 * The Figma board's drawer leads with the viewer's apps. The rows render
 * from here (./drawer-apps.tsx); the loader below is called by
 * `HeaderMenu.open()` in ./header-menu-controller.js, so the list refreshes
 * on every open and is never fetched for a drawer nobody looked at.
 *
 * ── Why a plain store ──────────────────────────────────────────────────
 *
 * Same reason as every store in this shell: the prerender must ship the
 * empty section (`apps: null` renders nothing), and the open-time writer is
 * a plain module. "Your apps" membership and ordering reuse the HOME
 * screen's own rules — `Home.isYours` / `Home.partitionApps`
 * (frontend/src/features/home/home.js) — through `window.Home`, because two
 * definitions of "your apps" would disagree eventually. `current` is a
 * snapshot of the open app at drawer-open time; the drawer closes on
 * navigation, so a snapshot is enough for the selected-row highlight.
 */

import { createStore } from '../../lib/plain-store.js';

export const drawerAppsStore = createStore({
  /** null until the first load; then the viewer's apps in home order. */
  apps: null,
  /** The open app's slug at drawer-open time, for the selected highlight. */
  current: null,
});

/** Refresh the section. Called from HeaderMenu.open(); safe to re-enter. */
export async function refreshDrawerApps() {
  const current = (typeof window !== 'undefined' && window.App?.currentApp) || null;
  drawerAppsStore.set({ current });
  try {
    // ?demo=1 forwarding, same as every other staging-aware fetch.
    const demo = new URLSearchParams(window.location.search).get('demo') === '1'
      ? '?demo=1' : '';
    const res = await fetch(`/api/apps${demo}`);
    if (!res.ok) return;
    const data = await res.json();
    const apps = Array.isArray(data) ? data : (data.apps || []);
    const partition = window.Home?.partitionApps;
    const yours = typeof partition === 'function'
      ? partition(apps).yours
      : apps.filter((a) => window.Home?.isYours?.(a));
    drawerAppsStore.set({ apps: yours, current });
  } catch {
    // A failed refresh keeps the previous list — the drawer still works.
  }
}
