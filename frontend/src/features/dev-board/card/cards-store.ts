/**
 * The Dev board's card surfaces, as plain serialisable view models.
 *
 * app-view.js computes and publishes; the components render. Three stores:
 *
 * - `devFeedStore` — the list feed (`#dev-feed`): the pinned own-sessions
 *   block, the stream's entries, the pager footer.
 * - `devKanbanStore` — the board: the four columns plus the active tab.
 *   Read by BOTH the columns (`#dev-kanban-board`) and the strip above the
 *   body (../board-tabs.tsx), which is why app-view.js publishes it from
 *   either layout — the strip is on screen while the stream is.
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
import type { DevFeedView, DevKanbanView } from './model';

// `loading: true` is the honest initial value for both: nothing has been
// fetched when the module loads. It is also why every view model app-view.js
// publishes carries the key EXPLICITLY — `set` merges a patch, so a model that
// omitted it would inherit whatever was published last and strand the surface
// on its placeholders.
export const devFeedStore = createStore<DevFeedView>({
  loading: true,
  block: [],
  emptyNote: null,
  entries: [],
  footer: null,
});

export const devKanbanStore = createStore<DevKanbanView>({
  activeTab: 'all',
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
