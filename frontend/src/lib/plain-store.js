/**
 * A five-line external store, in plain JS on purpose (#1085 chunk H).
 *
 * Chunk H's three islands (the staging overlay, the visual-compare overlay and
 * the app frame) are all driven from `public/js/app-view.js`, a classic script
 * that cannot import anything from this bundle. Each one therefore has a store
 * the legacy side writes through a bridge and the island reads with
 * `useSyncExternalStore`. This is the shared plumbing.
 *
 * Two deliberate properties:
 *
 * - **No React import anywhere in the chain.** The stores and the app-frame
 *   controller built on top of them are ordinary modules, so
 *   tests/app-frame-identity.test.js can import the REAL controller in Node and
 *   drive it against a fake renderer. The identity guarantee that test exists to
 *   pin (an app's iframe element is never re-created by a state change) lives in
 *   the controller, not in the JSX, and this is what makes it testable.
 * - **The flush is injected.** Updates that originate outside React are batched
 *   in React 18, but every legacy caller reads the DOM on its next line
 *   (`iframe.src = …` straight after mounting the frame; `_watchStagingIframeLoad`
 *   straight after opening the overlay). `setFlush(flushSync)` — called from the
 *   island's mount module, the only file in the chain that may import react-dom —
 *   restores the synchronous contract an `innerHTML` assignment used to give
 *   them. Without a flush installed (Node, the SSG pass) listeners simply run
 *   inline, which is the same ordering.
 */

/**
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  /** @type {(run: () => void) => void} */
  let flush = (run) => run();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => state,

    /**
     * Merge a patch (or replace via an updater) and notify synchronously.
     * A patch that changes nothing does not notify — that is what keeps
     * `mountFrame({ slug })` for the already-mounted app a genuine no-op.
     */
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      let changed = false;
      for (const key of Object.keys(next)) {
        if (next[key] !== state[key]) { changed = true; break; }
      }
      if (!changed && Object.keys(next).length === Object.keys(state).length) return;
      state = next;
      flush(notify);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    /** Install `flushSync` (see the header). Called once, from a mount module. */
    setFlush(next) {
      if (typeof next === 'function') flush = next;
    },

    /** Listener count — leak assertions in tests read this. */
    listenerCount: () => listeners.size,
  };
}
