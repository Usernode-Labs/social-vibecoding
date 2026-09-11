/**
 * How the Workshop groups the board below its summary: by the model's drafted
 * CATEGORIES, or by the board's own STAGES — the kanban columns, rendered in
 * place rather than on a screen of their own.
 *
 * ── Why the board can simply be rendered here ──────────────────────────
 *
 * Both surfaces were already React components fed by module-global stores:
 * `DevWorkshop` reads `devWorkshopStore`, `DevKanban` reads `devKanbanStore`
 * (../card/cards-store.ts). Neither owns its own fetching. So the "By stage"
 * pane is not a second board — it is the SAME `<DevKanban/>`, reading the same
 * published view model, nested inside the Workshop's tree. Nothing is
 * duplicated and nothing is re-derived, which is why the mobile column tabs,
 * the filter bar and every card action keep working unchanged.
 *
 * `#dev-kanban` and `#dev-kanban-tabs` are rendered by that component and are
 * therefore unique either way: the Board VIEW MODE replaces `#dev-body`'s
 * contents outright (`_repaintDevBody`), so `#dev-workshop` does not exist
 * while the standalone board does, and vice versa. The two can never be on
 * screen at once.
 *
 * ── Why a store, and not just `useState` ───────────────────────────────
 *
 * Deliberately mirrors ../view-mode-store.ts, for its reason: app-view.js has
 * to KNOW which pane is showing, because `_rerenderWorkshop()` publishes the
 * kanban view model only when the stage pane is up — building it on every
 * Workshop repaint would bucket, order and filter the whole board for a pane
 * nobody is looking at. Read that file's header for the store mechanics; the
 * split of responsibilities is identical:
 *
 *   * the PREFERENCE (localStorage `devWorkshopGroup`) lives in app-view.js,
 *     in `_getWorkshopGroup()` / `_setWorkshopGroup()`;
 *   * this store is a MIRROR of that value for rendering;
 *   * a tab click calls `AppView._setWorkshopGroup(mode)`, which persists,
 *     publishes here, and repaints through `_repaintBoardSurface()`.
 *
 * Seeding happens on every `_rerenderWorkshop()` rather than once at mount,
 * because the Workshop host is torn down and rebuilt by `_repaintDevBody()`
 * whenever the view mode changes — so there is no single mount to seed from.
 */

import { useSyncExternalStore } from 'react';

export const WORKSHOP_GROUP_STORE_KEY = '__usernodeWorkshopGroup';

export const WORKSHOP_GROUPS = ['category', 'stage'] as const;

export type WorkshopGroup = (typeof WORKSHOP_GROUPS)[number];

/**
 * Category is the default: it is what the Workshop has always shown, and the
 * stage pane is the board a viewer can already reach from the view strip.
 */
export const DEFAULT_WORKSHOP_GROUP: WorkshopGroup = 'category';

export function isWorkshopGroup(value: unknown): value is WorkshopGroup {
  return typeof value === 'string' && (WORKSHOP_GROUPS as readonly string[]).includes(value);
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
 * Publish the active grouping.
 *
 * Called from `AppView._setWorkshopGroup()` and, to seed, from
 * `AppView._rerenderWorkshop()` before it publishes the view.
 */
export function publishWorkshopGroup(mode: string): void {
  const next = isWorkshopGroup(mode) ? mode : DEFAULT_WORKSHOP_GROUP;
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
