/**
 * State for the "App device permissions" settings section (#2219).
 *
 * The sibling of ./grants-store.js, and the same seam for the same reason:
 * settings.js is a classic script loaded before this bundle and cannot
 * import, so the publisher is hung off `window.UsernodeReact` at
 * module-evaluation time.
 *
 * @typedef {{ capability: string, label: string, revoked: boolean }} PermissionItem
 * @typedef {{ appId: number, appName: string, appSlug: string, items: PermissionItem[] }} PermissionAppView
 * @typedef {{ phase: 'idle'|'loading'|'error'|'ready', apps: PermissionAppView[] }} AppPermissionsState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is exactly the empty
 * `<div id="app-permissions-list">` that sections/app-permissions.tsx ships
 * and the SSG prerender emits. The list is fetched when the section opens, so
 * a first render that drew a "Loading…" line would be a hydration mismatch —
 * which console.errors, and a console error on any route fails proposal
 * checks.
 */
export const INITIAL_APP_PERMISSIONS = /** @type {AppPermissionsState} */ ({ phase: 'idle', apps: [] });

export const appPermissionsStore = createStore(INITIAL_APP_PERMISSIONS);

/** See the note in ./grants-store.js — same publisher contract. */
if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsAppPermissions = {
    publish: (next) => appPermissionsStore.set(next),
  };
}
