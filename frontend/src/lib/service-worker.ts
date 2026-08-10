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

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Unsupported / blocked contexts (e.g. some WebViews) just keep
    // today's online-only behaviour.
  });
}
