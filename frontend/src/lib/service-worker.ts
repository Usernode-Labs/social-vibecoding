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
 *
 * ── NOTHING HERE MAY THROW ────────────────────────────────────────────
 *
 * main.tsx calls registerServiceWorker() at module scope, ABOVE
 * `flushSync(() => hydrateRoot(document.body, <Shell />))`. A throw on this
 * line therefore aborts the entry module before hydration ever starts: React
 * never adopts the document, every island stays the empty markup the
 * prerender shipped, `window.Offline` is never installed, and the legacy
 * public/js/** scripts run against a shell with no reconciler behind it. The
 * viewer is left on a static document that paints once and then goes
 * wherever the legacy router puts it — which, with the screens empty, is a
 * blank page.
 *
 * That is an absurd blast radius for a precache and a cache-freshness
 * listener, and the guard that used to stand in front of it did not hold:
 * `'serviceWorker' in navigator` tests for the ATTRIBUTE, and WebKit installs
 * the attribute and then hands back `undefined` — or throws `SecurityError`
 * off the getter — wherever the worker is unavailable to the page. A
 * WKWebView whose host app has not opted its domains into
 * `WKAppBoundDomains`, a `WKWebsiteDataStore.nonPersistent()` store, Safari
 * with site data blocked: the `in` test passes in every one of them and the
 * next statement dereferences `undefined`.
 *
 * So the container is resolved once, defensively, and every call into it is
 * guarded. `register()` needs BOTH forms of guard: it rejects for the
 * ordinary failures, but throws SYNCHRONOUSLY for the blocked-storage
 * SecurityError, which a `.catch()` never sees.
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
 * The real `navigator.serviceWorker`, or null wherever this page cannot use
 * one. Feature-detects the METHOD rather than the attribute name, because the
 * attribute is present in contexts where the object behind it is not.
 */
function swContainer(): ServiceWorkerContainer | null {
  try {
    const container = navigator.serviceWorker;
    return container && typeof container.register === 'function' ? container : null;
  } catch {
    // WebKit throws SecurityError off the getter itself when site data is
    // blocked. Same answer as "not available".
    return null;
  }
}

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
function listenForApiUpdates(container: ServiceWorkerContainer): void {
  container.addEventListener('message', (event: MessageEvent) => {
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
  const container = swContainer();
  if (!container) return;
  try {
    listenForApiUpdates(container);
    container.register('/sw.js').catch(() => {
      // Unsupported / blocked contexts (e.g. some WebViews) just keep
      // today's online-only behaviour.
    });
  } catch {
    // The same outcome, arriving synchronously instead of as a rejection.
  }
}
