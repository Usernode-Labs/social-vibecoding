/**
 * The props `#dev-actions` needs, published so the WORKSHOP can render it.
 *
 * ── Why a store and not a prop ─────────────────────────────────────────
 *
 * The toolbar's two homes are in two different React ROOTS. ./board-frame.tsx
 * is mounted into `#app-content` by an interim root and takes its props from
 * `AppView.renderDevView()`'s `mountBoard(host, options)` call;
 * ./workshop/workshop.tsx is a separate legacy portal into `#dev-workshop`,
 * fed by `devWorkshopStore`, and has no path to those options at all. So the
 * six flags the row reads are published here once, at the same moment the
 * frame is mounted, and both roots read the same object.
 *
 * Deliberately NOT folded into the Workshop's own view model: those flags are
 * facts about the APP and the viewer's permissions, not about the board's
 * contents, and `_workshopView()` is rebuilt from the card caches on every
 * repaint. Publishing them there would re-derive six constants dozens of times
 * a session and put app permissions in a structure about themes.
 *
 * Shaped like ./view-mode-store.ts — read that file's header for the store
 * mechanics — with one difference: the snapshot is an OBJECT, so it is
 * identity-cached. `useSyncExternalStore` re-renders whenever the snapshot is
 * `!==` the last one, and a fresh object per call would loop forever.
 */

import { useSyncExternalStore } from 'react';

export const DEV_ACTIONS_STORE_KEY = '__usernodeDevActions';

export interface DevActionsState {
  illustrationApp?: any;
  canManageIllustration?: boolean;
  selfHosted: boolean;
  readOnly: boolean;
  canCollaborate: boolean;
  showsMembers: boolean;
}

export const DEFAULT_DEV_ACTIONS: DevActionsState = {
  illustrationApp: null,
  canManageIllustration: false,
  selfHosted: false,
  readOnly: false,
  canCollaborate: false,
  showsMembers: false,
};

export interface DevActionsStore {
  state: DevActionsState;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & { [DEV_ACTIONS_STORE_KEY]?: DevActionsStore };

export function getDevActionsStore(): DevActionsStore {
  const host = globalThis as StoreHost;
  let store = host[DEV_ACTIONS_STORE_KEY];
  if (!store) {
    store = { state: DEFAULT_DEV_ACTIONS, listeners: new Set() };
    host[DEV_ACTIONS_STORE_KEY] = store;
  }
  return store;
}

/**
 * Publish the toolbar's props. Called from `devBoardBridge.mountBoard`, before
 * the frame renders, so the Workshop's first paint has them.
 *
 * Compares field by field and keeps the previous object when nothing moved:
 * `mountBoard` runs on every `renderDevView()`, which is every navigation back
 * onto the Dev screen, and a new object each time would re-render the toolbar
 * — and with it the "+" menu — for no change.
 */
export function publishDevActions(next: DevActionsState): void {
  const store = getDevActionsStore();
  const cur = store.state;
  const same = cur.selfHosted === next.selfHosted
    && cur.readOnly === next.readOnly
    && cur.canCollaborate === next.canCollaborate
    && cur.showsMembers === next.showsMembers
    && cur.canManageIllustration === next.canManageIllustration
    && cur.illustrationApp === next.illustrationApp;
  if (same) return;
  store.state = next;
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[dev-board] actions listener failed', err);
    }
  }
}

function subscribe(onChange: () => void): () => void {
  const store = getDevActionsStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

function getSnapshot(): DevActionsState {
  return getDevActionsStore().state;
}

/** Subscribe a surface to the toolbar's props. */
export function useDevActions(): DevActionsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
