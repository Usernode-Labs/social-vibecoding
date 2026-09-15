/**
 * State for the per-app notification roll-up in Settings (#1374).
 *
 * Same seam as ./grants-store.js and ./app-permissions-store.js: settings.js
 * is a classic script loaded before this bundle and cannot import, so the
 * publisher hangs off `window.UsernodeReact` at module-evaluation time.
 *
 * @typedef {{ key: string, label: string, description: string, enabled: boolean,
 *   source: 'account'|'default', appScoped: boolean }} AccountCategory
 * @typedef {{ appId: number, appSlug: string, appName: string,
 *   categories: { key: string, label: string, enabled: boolean }[] }} AppOverride
 * @typedef {{ phase: 'idle'|'loading'|'error'|'ready',
 *   categories: AccountCategory[], apps: AppOverride[] }} NotificationPrefsState
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `idle` renders NOTHING, which is the empty host the prerender emits.
 * Anything else on the first pass is a hydration mismatch, which
 * console.errors and fails proposal checks.
 */
export const INITIAL_NOTIFICATION_PREFS = /** @type {NotificationPrefsState} */ ({
  phase: 'idle', categories: [], apps: [],
});

export const notificationPrefsStore = createStore(INITIAL_NOTIFICATION_PREFS);

if (typeof window !== 'undefined') {
  const w = /** @type {any} */ (window);
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.settingsNotificationPrefs = {
    publish: (next) => notificationPrefsStore.set(next),
  };
}
