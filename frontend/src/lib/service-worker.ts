/**
 * Service-worker registration for the platform shell (#487, moved in #1078).
 *
 * This used to be the first thing /js/offline.js did. That module is gone —
 * chunk A of the step-2 conversion replaced its banner with a React island —
 * so registration moved into the React bundle with it. It is deliberately its
 * own module rather than a line inside the offline engine: they are unrelated
 * concerns that merely happened to ship in the same file, and
 * tests/pwa-shell-wiring.test.js asserts against this file by name.
 *
 * Timing note: the shell's legacy scripts are classic scripts at the end of
 * <body> and the React entry is a deferred module, so registration now happens
 * a beat later than it did — after parsing, still before DOMContentLoaded and
 * therefore before App.init(). The SW's job is to precache for the NEXT load,
 * so nothing on this load depends on the difference.
 */

/**
 * Fired when the worker reports that a cached API answer it already served
 * is now out of date. `detail.url` is the request it applies to.
 *
 * Named and dispatched like `usernode:offline-change` on purpose: the same
 * seam, the same delivery mechanism, and the same rule that classic scripts
 * in public/js/** may listen without importing anything.
 */
export const API_UPDATED_EVENT = 'usernode:api-updated';

/**
 * The page half of the worker's late-arrival correction.
 *
 * A service worker gets to return exactly ONE response per request, so when
 * it answers a slow GET /api/* from cache (public/sw.js, API_TIMEOUT_MS) the
 * real answer that lands a moment later has nowhere to go — it refreshes the
 * cache and the screen keeps showing the stale copy until the next reload.
 * The worker posts `api-updated` when, and only when, the answer it served
 * from cache turned out to disagree with the real one; this re-broadcasts it
 * as a DOM event that App._onApiUpdated acts on.
 *
 * On a healthy connection nothing is ever served stale, so this never fires.
 */
function listenForApiUpdates(): void {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (!data || data.type !== 'api-updated') return;
    try {
      window.dispatchEvent(new CustomEvent(API_UPDATED_EVENT, {
        detail: { url: data.url },
      }));
    } catch {
      // CustomEvent unavailable — the screen just keeps what it was served.
    }
  });
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  listenForApiUpdates();
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Unsupported / blocked contexts (e.g. some WebViews) just keep
    // today's online-only behaviour.
  });
}
