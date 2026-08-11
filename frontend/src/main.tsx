// The React shell's browser entry point.
//
// Emitted (unhashed, single chunk) as /shell/assets/shell.js and referenced
// from the LAST line of <head> in the generated public/index.html.
//
// ── Why the entry is a <head> module, and why hydration is flushSync'd ──
//
// The load order this file has to preserve, exactly as it was before the
// React chassis existed:
//
//   1. the head's blocking classic scripts  (theme.js, usernode-bridge.js,
//      the .in-native-webview inline script, the three vendored libs, the
//      native kit) — they must still run before anything paints;
//   2. the 47 classic <script src="/js/…"> tags at the end of <body>, in
//      order, each defining its global — app.js LAST, so App.init()
//      registers its DOMContentLoaded handler after every other module's;
//   3. DOMContentLoaded — every module's init() runs and starts writing
//      into the DOM (innerHTML, class toggling, appendChild).
//
// A `type="module"` script is deferred, so placing this at the end of <head>
// puts it after (2) and before (3): the legacy globals all exist and the
// document is fully parsed when hydration begins, and hydration is finished
// before the first init() touches anything. That is the same window the old
// shell had between "last script tag ran" and "DOMContentLoaded fired", i.e.
// no timing change at all.
//
// flushSync is what makes that guarantee hold. hydrateRoot on its own
// hydrates in a concurrent lane that can yield to the scheduler and resume
// in a LATER task — potentially after DOMContentLoaded, i.e. while
// App.init() and friends are rewriting the very subtrees React is still
// adopting. Every such collision is a hydration mismatch, every mismatch is
// a console.error, and a console.error on any route fails the platform's
// proposal checks (see the cascade probe in the head for the same
// reasoning). Wrapping the initial hydration in flushSync forces it to
// complete synchronously inside this task, so that interleaving cannot
// happen.
//
// The second guard is in Shell.tsx: the tree is static except for explicitly
// converted ISLANDS, and a region only becomes an island once its entire
// subtree is React-owned — so React still never reconciles over DOM another
// module writes into. Both guards are load-bearing. Read the header comment
// there before making any further part of the shell tree stateful.
//
// ── What runs here BEFORE hydration, and why ───────────────────────────
//
// Two things that /js/offline.js used to do at classic-script time, and that
// moved into this bundle when #1078 retired that module:
//
//   * service-worker registration — nothing on this load depends on it;
//   * the connectivity engine, which installs `window.Offline`.
//
// The second is ordered deliberately: it runs at module scope, before
// hydration, because App.init() calls `Offline.forceOffline()` for the
// `?shot=offline` deep links and home.js / auth-screens.js read
// `Offline.isOffline()` while painting their first frame. All of that happens
// on DOMContentLoaded — after this module executes — so the API is in place
// in time, exactly as it was when a <body> script defined it.

import { flushSync } from 'react-dom';
import { hydrateRoot } from 'react-dom/client';

import { Shell } from './Shell';
import { initOffline } from './lib/offline';
import { registerServiceWorker } from './lib/service-worker';
// Publishes window.UsernodeReact.devBoard at module scope. Imported for the
// side effect, and imported HERE (rather than reached from a Shell island)
// because the Dev surfaces are runtime-injected into an empty #app-content and
// so have no island to hang off — see that file's header and
// ./lib/interim-root.ts. app-view.js can reach the API from the moment
// DOMContentLoaded fires, which is the earliest App.switchTab() can run.
import './features/dev-board/mount';

registerServiceWorker();
initOffline();

// document.body is the hydration container, not a wrapper <div>, because the
// body element itself is the flex column the layout depends on
// (`class="… flex flex-col" style="height:100dvh"` with `flex-1` <main>
// children). Interposing a wrapper would break every screen's height.
flushSync(() => {
  hydrateRoot(document.body, <Shell />);
});
