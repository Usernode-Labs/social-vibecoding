/**
 * The screen-visibility seam between `public/js/**` and React-owned regions.
 *
 * ── The problem it solves (#1078, mechanism 2) ─────────────────────────
 *
 * The shell's router is `App.restoreFromHash()` in public/js/app.js, and it
 * swaps screens by toggling `.hidden` on the seven roots in `App.SCREEN_IDS`
 * (`App._showOnlyScreen`). dapp.json's declared tests then assert
 * `#leaderboard-screen:not(.hidden) …`, so that class IS the contract.
 *
 * Once a screen root becomes a React component, a `classList.add('hidden')`
 * from outside React is a write into React-owned DOM: the next render
 * reconciles it away, and the two owners fight. So visibility has to become
 * *data* that both sides read:
 *
 *   - the legacy router PUBLISHES `(screenId, visible)` here instead of
 *     touching the class (see `App._setScreenVisible`),
 *   - the converted region SUBSCRIBES and renders its own `hidden` class,
 *     producing exactly the same DOM the router used to produce by hand.
 *
 * Unconverted roots keep the `classList` path — `App.REACT_SCREEN_IDS` is the
 * list of ids that have crossed over — so the two halves coexist for the whole
 * conversion run and no chunk has to move every screen at once.
 *
 * ── Why the state lives on `window`, not in this module ────────────────
 *
 * Load order. The legacy `<script>` tags are classic scripts at the end of
 * `<body>`; the React entry is a deferred module, so it runs AFTER all of
 * them. app.js can therefore publish before this module has ever been
 * evaluated, and the value has to survive until React shows up. The store is a
 * plain object on `window` created by whichever side touches it first — the
 * factory below is duplicated, deliberately and identically, in app.js's
 * `App.Visibility`. Keep the two in sync; the shape is asserted by
 * tests/visibility-store.test.js.
 *
 * Note there is no default: an id nobody has published is `undefined`, not
 * `false`. A converted region must fall back to the visibility its
 * hand-written markup shipped with, because its FIRST render happens during
 * hydration — before app.js's router has necessarily said anything — and a
 * first render that disagrees with the prerendered markup is a hydration
 * mismatch, which console.errors and fails proposal checks.
 */

import { useSyncExternalStore } from 'react';

export const VISIBILITY_STORE_KEY = '__usernodeVisibility';

export interface VisibilityStore {
  /** id → visible. Absent means "nobody has published this yet". */
  visible: Record<string, boolean>;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & { [VISIBILITY_STORE_KEY]?: VisibilityStore };

/** The shared store, created on first touch by whichever side gets there. */
export function getVisibilityStore(): VisibilityStore {
  const host = globalThis as StoreHost;
  let store = host[VISIBILITY_STORE_KEY];
  if (!store) {
    store = { visible: Object.create(null) as Record<string, boolean>, listeners: new Set() };
    host[VISIBILITY_STORE_KEY] = store;
  }
  return store;
}

/** Publish a screen's visibility. No-ops when the value is unchanged. */
export function publishVisibility(id: string, visible: boolean): void {
  const store = getVisibilityStore();
  if (store.visible[id] === visible) return;
  store.visible[id] = visible;
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[visibility] listener failed', err);
    }
  }
}

/** Read a published visibility. `undefined` when nothing has published it. */
export function readVisibility(id: string): boolean | undefined {
  return getVisibilityStore().visible[id];
}

function subscribe(onChange: () => void): () => void {
  const store = getVisibilityStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

/**
 * Subscribe a React region to a screen's visibility.
 *
 * `initial` is what the hand-written markup shipped — the value used until
 * something publishes, so the first (hydrating) render matches the prerendered
 * DOM exactly. The snapshot is a primitive, so `useSyncExternalStore`'s
 * identity check is enough and no memoisation is needed.
 */
export function useVisibility(id: string, initial: boolean): boolean {
  const snapshot = () => {
    const value = readVisibility(id);
    return value === undefined ? initial : value;
  };
  // Server (prerender) and client agree by construction: the prerender pass
  // has no publisher at all, so both sides start from `initial`.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
