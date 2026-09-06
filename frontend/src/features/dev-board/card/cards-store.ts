/**
 * The Dev board's card surfaces, as plain serialisable view models.
 *
 * app-view.js computes and publishes; the components render. Three stores:
 *
 * - `devWorkshopStore` — the Workshop (`#dev-workshop`): the Dev screen's
 *   lander, which replaced the Activity feed. Its themes, the vote strip,
 *   the since-last-visit strip and the discussion row are one publish
 *   (see AppView._workshopView).
 * - `devKanbanStore` — the board (`#dev-kanban-board`): the four columns
 *   plus the mobile tab strip's active key.
 * - `cardNowStore` / `aiEnabledStore` — the two cross-cutting facts that
 *   used to be applied by in-place DOM passes: the 30s countdown tick
 *   (`_startMergeCountdownTimer` rewrote pill labels) and `/api/budget`'s
 *   aiEnabled answer (`_applyExploreChatAvailability` dimmed the Explore
 *   pills). Both are one value each, so a tick re-renders only what reads
 *   them.
 *
 * The opened topic's head has its own store one directory over
 * (../topic/topic-store.ts): it publishes the card AND the body under it as
 * one value, because they are rebuilt together on every paint.
 */

import { createStore } from '../../../lib/plain-store.js';
import type { DevKanbanView, DevWorkshopView } from './model';

// `loading: true` is the honest initial value for both: nothing has been
// fetched when the module loads. It is also why every view model app-view.js
// publishes carries the key EXPLICITLY — `set` merges a patch, so a model that
// omitted it would inherit whatever was published last and strand the surface
// on its placeholders.
export const EMPTY_WORKSHOP_VIEW: DevWorkshopView = {
  loading: true,
  emptyNote: null,
  votes: { count: 0, rows: [] },
  since: null,
  welcome: null,
  discussion: null,
  themes: [],
  meta: { source: null, generatedAt: null, stale: false, pending: false, filtered: false },
  autoExpand: null,
};

export const devWorkshopStore = createStore<DevWorkshopView>(EMPTY_WORKSHOP_VIEW);

export const devKanbanStore = createStore<DevKanbanView>({
  activeTab: 'issues',
  cols: [],
  loading: true,
});

/** `Date.now()` at the last 30s tick; 0 until the first, when baked labels hold. */
export const cardNowStore = createStore<{ now: number }>({ now: 0 });

/**
 * Optimistic until `/api/budget` answers, exactly as the DOM pass was —
 * the endpoint itself 503s when AI is truly off.
 */
export const aiEnabledStore = createStore<{ enabled: boolean }>({ enabled: true });
