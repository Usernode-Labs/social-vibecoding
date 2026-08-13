/**
 * The Leaderboard screen's section seam between ./leaderboard.js and the island
 * that renders its tab strip (#1083 chunk F).
 *
 * ── Why a store at all ─────────────────────────────────────────────────
 *
 * `Leaderboard._renderSectionTabs()` used to innerHTML three buttons into
 * #standings-tabs and bind a click handler to each. That host is now rendered by
 * <LeaderboardScreen/> through the Tabs primitive, and the migration's rule is
 * that a region may become stateful only when its whole subtree is React-owned —
 * so the module cannot keep writing there. Instead it PUBLISHES the section it
 * just switched to and React renders the strip, producing exactly the markup the
 * template produced.
 *
 * The direction of the click is unchanged: a trigger calls
 * `Leaderboard._setSection(key)`, which is what the innerHTML'd button's
 * listener did, so hash syncing, pane visibility and the lazy mount of each
 * guest module all still run in the module.
 *
 * ── Why the state lives on `window` ────────────────────────────────────
 *
 * The same load-order reason as lib/visibility-store.ts, which this mirrors
 * deliberately. ./leaderboard.js is bundled now, so it could import this file —
 * but keeping it import-free means the module stays a plain object literal that
 * tests/standings-screen.test.js and friends can read and eval as text, and it
 * means the publish path is identical whether the caller is bundled or not. The
 * accessor below is duplicated, deliberately and identically, at the top of
 * ./leaderboard.js; keep the two in sync.
 *
 * ── `mounted` is one-way ───────────────────────────────────────────────
 *
 * The strip ships EMPTY — the hand-written shell had an empty #standings-tabs
 * and the module filled it on open() — so the island's first (hydrating) render
 * must emit nothing inside the host. `mounted` flips true the first time the
 * screen opens and never goes back, because `Leaderboard.close()` never cleared
 * the strip either: closing the screen left the buttons in the hidden <main>.
 * Rendering them away on close would be a rendered-DOM change, invisible though
 * it would be.
 */

import { useSyncExternalStore } from 'react';

export const LEADERBOARD_SECTION_STORE_KEY = '__usernodeLeaderboardSection';

/** The primary section, and the one a fresh page load opens on. */
export const DEFAULT_SECTION = 'topochain';

export interface LeaderboardSectionStore {
  /** False until the screen has been opened once — see the header. */
  mounted: boolean;
  /** 'topochain' | 'kudos' | 'challenges'. */
  section: string;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & {
  [LEADERBOARD_SECTION_STORE_KEY]?: LeaderboardSectionStore;
};

/** The shared store, created on first touch by whichever side gets there. */
export function getSectionStore(): LeaderboardSectionStore {
  const host = globalThis as StoreHost;
  let store = host[LEADERBOARD_SECTION_STORE_KEY];
  if (!store) {
    store = { mounted: false, section: DEFAULT_SECTION, listeners: new Set() };
    host[LEADERBOARD_SECTION_STORE_KEY] = store;
  }
  return store;
}

/**
 * Publish the active section. Marks the strip mounted — every caller is a
 * point where the module used to render it.
 */
export function publishSection(section: string): void {
  const store = getSectionStore();
  if (store.mounted && store.section === section) return;
  store.mounted = true;
  store.section = section;
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[leaderboard] section listener failed', err);
    }
  }
}

function subscribe(onChange: () => void): () => void {
  const store = getSectionStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

export interface SectionSnapshot {
  mounted: boolean;
  section: string;
}

/**
 * Subscribe the island to the active section.
 *
 * The snapshot is an object, so it is cached and only replaced when one of the
 * two fields actually changes — `useSyncExternalStore` compares by identity and
 * a fresh object every call would loop forever.
 */
let cached: SectionSnapshot = { mounted: false, section: DEFAULT_SECTION };

function getSnapshot(): SectionSnapshot {
  const store = getSectionStore();
  if (cached.mounted !== store.mounted || cached.section !== store.section) {
    cached = { mounted: store.mounted, section: store.section };
  }
  return cached;
}

/** The prerender pass has no publisher, so the server snapshot is the shipped one. */
const SERVER_SNAPSHOT: SectionSnapshot = { mounted: false, section: DEFAULT_SECTION };

export function useLeaderboardSection(): SectionSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}
