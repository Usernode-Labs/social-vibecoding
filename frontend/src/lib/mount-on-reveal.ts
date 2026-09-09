/**
 * Mount a screen's INTERIOR on its first reveal, not in the prerender.
 *
 * ── The problem ─────────────────────────────────────────────────────────
 *
 * The shell is one document for every screen: public/index.html carried
 * 1,485 elements, and 681 of them — #settings-screen's sixteen panes (437)
 * and the six anonymous-shell screens (244) — sit hidden behind roots a
 * signed-in visitor on the board never reveals. Every load still parsed,
 * styled and hydrated them. Home, leaderboard, profile, browse, messages and
 * admin ship as empty chassis and fill themselves at runtime; this is the
 * same shape for the two that did not.
 *
 * ── The seam ─────────────────────────────────────────────────────────────
 *
 * Each root element stays in the prerender exactly as it was — same id, same
 * class string, same `hidden` — because app.js reads the roots by id and the
 * declared checks select on them. Only the CHILDREN wait: a screen renders
 * them once `useMountedOnReveal(id)` is true, which happens the first time
 * either
 *
 *   - the visibility store publishes `true` for the root (the router
 *     revealed it), or
 *   - a legacy caller asks for it outright through `ensureMounted(id)`.
 *
 * The second path is the load-bearing one. `Settings.open()` renders every
 * pane into the still-hidden screen and reads their ids on its next line;
 * `AuthScreens.show()` wires a screen and runs its on-show hook before it
 * reveals it. Both are synchronous contracts written against markup that was
 * always in the document, so `ensureMounted` mounts the interior inside
 * `flushSync` and returns with the nodes already there.
 *
 * `mounted` is one-way, like the leaderboard's section store: nothing ever
 * renders an interior away, because nothing ever removed the markup before.
 *
 * ── Why the state lives on `window` ─────────────────────────────────────
 *
 * The same load-order reason as ./visibility-store.ts, which this mirrors:
 * the classic scripts run before the React entry, and `ensureMounted` is
 * reached by name (`window.UsernodeReact.mount.ensure`) rather than imported
 * — settings.js and auth-screens.js are loaded as scripts by a dozen tests.
 * The prerender pass has no publisher, so both sides start from `false`, and
 * the first client render matches the empty root the document shipped.
 */

import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { getVisibilityStore, readVisibility } from './visibility-store';

export const MOUNTED_STORE_KEY = '__usernodeMounted';

export interface MountedStore {
  /** id → true once the interior has been asked for. Absent means never. */
  mounted: Record<string, true>;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & { [MOUNTED_STORE_KEY]?: MountedStore };

/** The shared store, created on first touch by whichever side gets there. */
export function getMountedStore(): MountedStore {
  const host = globalThis as StoreHost;
  let store = host[MOUNTED_STORE_KEY];
  if (!store) {
    store = { mounted: Object.create(null) as Record<string, true>, listeners: new Set() };
    host[MOUNTED_STORE_KEY] = store;
  }
  return store;
}

/** Has anything asked for this interior yet? Reads the store only. */
export function isMarkedMounted(id: string): boolean {
  return getMountedStore().mounted[id] === true;
}

function notify(store: MountedStore): void {
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[mount-on-reveal] listener failed', err);
    }
  }
}

/** Mark an interior wanted. Idempotent; notifies subscribers synchronously. */
export function markMounted(id: string): void {
  const store = getMountedStore();
  if (store.mounted[id]) return;
  store.mounted[id] = true;
  notify(store);
}

/**
 * Mount an interior NOW and return with its nodes in the document.
 *
 * `flushSync` is what turns the store notification into a committed render
 * before this returns. Outside a browser (the SSG pass, a `vm` test) there is
 * nothing to flush, so the mark alone is the whole effect. Returns whether
 * the interior was already mounted, so a caller can tell a first reveal from
 * a re-entry.
 */
export function ensureMounted(id: string): boolean {
  if (isMarkedMounted(id)) return true;
  if (typeof document === 'undefined') {
    markMounted(id);
    return false;
  }
  flushSync(() => {
    markMounted(id);
  });
  return false;
}

function subscribe(onChange: () => void): () => void {
  const store = getMountedStore();
  store.listeners.add(onChange);
  // A reveal through the visibility store mounts the interior too, so
  // subscribe to both — the snapshot below reads both.
  const visibility = getVisibilityStore();
  visibility.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
    visibility.listeners.delete(onChange);
  };
}

/**
 * Whether a screen should render its interior.
 *
 * True once the root has been revealed (visibility published `true`) or
 * asked for (`ensureMounted`). The snapshot is a primitive, so
 * `useSyncExternalStore`'s identity check is enough. The server snapshot is
 * `false` by construction: the prerender pass has no publisher, and an empty
 * root is exactly what the document ships.
 */
export function useMountedOnReveal(id: string): boolean {
  const snapshot = () => isMarkedMounted(id) || readVisibility(id) === true;
  // The server snapshot reads the MARK alone. The SSG prerender marks
  // nothing, so it emits the empty root the document ships; a test that
  // wants an interior's markup marks the id and renders the same component
  // (tests/lib/lazy-interiors.js) — that is how the structural inventory
  // still accounts for every id that moved off the prerender.
  return useSyncExternalStore(subscribe, snapshot, () => isMarkedMounted(id));
}

// The bridge the classic scripts reach for by name. Published at module
// evaluation, like the visibility store's publisher on app.js's side, so it
// exists before any DOMContentLoaded handler can call Settings.open() or
// AuthScreens.show().
if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.mount = { ensure: ensureMounted, isMounted: isMarkedMounted };
}
