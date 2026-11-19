/**
 * Which pane All items draws: the board's own STAGES, the kanban columns
 * rendered in place. It was a choice between that and the model's drafted
 * CATEGORIES until request 6708 made the stage board the one view.
 *
 * The stage pane is not a second board: `DevWorkshop` reads
 * `devWorkshopStore`, `DevKanban` reads `devKanbanStore`
 * (../card/cards-store.ts), and the pane is the SAME `<DevKanban/>` nested in
 * the Workshop's tree, so the mobile column tabs, the filter bar and every
 * card action work unchanged. `#dev-kanban` and `#dev-kanban-tabs` are
 * rendered by that component and are unique.
 *
 * The value lives in a module-global store, as ../view-mode-store.ts does,
 * from when app-view.js chose the pane and had to know which was up.
 */

import { useSyncExternalStore } from 'react';

export const WORKSHOP_GROUP_STORE_KEY = '__usernodeWorkshopGroup';

export const WORKSHOP_GROUPS = ['category', 'stage'] as const;

export type WorkshopGroup = (typeof WORKSHOP_GROUPS)[number];

/**
 * Stage is the default, and in the product the only value (request 6708).
 *
 * All items is the board by stage: its "By category" / "By stage" switch is
 * gone, app-view.js no longer stores or reads a choice, and nothing in the
 * product publishes to this store, so it rests here. The category pane and
 * this store are kept for now, unreached; a suite that still draws the
 * category lanes publishes 'category' itself.
 *
 * 'theme' is #2332's spelling of 'category', still resolved for that.
 */
export const DEFAULT_WORKSHOP_GROUP: WorkshopGroup = 'stage';

/** Spellings retired along the way, still honoured so a preference survives. */
const LEGACY_GROUPS: Record<string, WorkshopGroup> = { theme: 'category' };

export function isWorkshopGroup(value: unknown): value is WorkshopGroup {
  return typeof value === 'string' && (WORKSHOP_GROUPS as readonly string[]).includes(value);
}

/** A stored or linked value resolved onto a current one, or null. */
export function migrateWorkshopGroup(value: unknown): WorkshopGroup | null {
  if (isWorkshopGroup(value)) return value;
  return (typeof value === 'string' && LEGACY_GROUPS[value]) || null;
}

export interface WorkshopGroupStore {
  mode: WorkshopGroup;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & {
  [WORKSHOP_GROUP_STORE_KEY]?: WorkshopGroupStore;
};

/** The shared store, created on first touch by whichever side gets there. */
export function getWorkshopGroupStore(): WorkshopGroupStore {
  const host = globalThis as StoreHost;
  let store = host[WORKSHOP_GROUP_STORE_KEY];
  if (!store) {
    store = { mode: DEFAULT_WORKSHOP_GROUP, listeners: new Set() };
    host[WORKSHOP_GROUP_STORE_KEY] = store;
  }
  return store;
}

/**
 * Publish the active grouping. No product code calls this since request
 * 6708; an unknown value is the default, the stage pane.
 */
export function publishWorkshopGroup(mode: string): void {
  const next = migrateWorkshopGroup(mode) || DEFAULT_WORKSHOP_GROUP;
  const store = getWorkshopGroupStore();
  if (store.mode === next) return;
  store.mode = next;
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[dev-board] workshop-group listener failed', err);
    }
  }
}

function subscribe(onChange: () => void): () => void {
  const store = getWorkshopGroupStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

function getSnapshot(): WorkshopGroup {
  return getWorkshopGroupStore().mode;
}

/**
 * Subscribe the Workshop to the active grouping.
 *
 * The server snapshot is the LIVE value, not the constant ../view-mode-store.ts
 * uses. That store's constant guards a hydrating render; nothing hydrates this
 * one — `#dev-workshop` is created by `_repaintDevBody` long after hydration
 * and is absent from the prerendered document, so there is no shipped markup
 * to match and no mismatch to cause. Reading the store is therefore both
 * correct and what makes the stage pane renderable by
 * `renderToStaticMarkup`, which is how the checks and the tests see it.
 */
export function useWorkshopGroup(): WorkshopGroup {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
