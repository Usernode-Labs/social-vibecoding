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
  week: null,
  dashboard: null,
  nextUp: null,
  discussion: null,
  themes: [],
  meta: {
    source: null, generatedAt: null, discoveredAt: null, stale: false, pending: false, pendingStage: null,
    lastError: null, coverage: null, placing: 0, filtered: false,
  },
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

/**
 * #3984: votes on their way, by `<fn>:<id>` (`castVote:12`,
 * `castIssueVote:5`), with the side sent. castVote and castIssueVote set it
 * once the vote is committed to (the line is in hand) and clear it when the
 * server answers, through the bridge's `publishVoteSending`, whichever
 * surface the vote came from. A card's Vote button reads "Sending…" and
 * takes no press while its vote is here.
 */
export const voteSendingStore = createStore<Record<string, 'yes' | 'no'>>({});

export function publishVoteSending(key: string, side: 'yes' | 'no' | null): void {
  voteSendingStore.set((cur: Record<string, 'yes' | 'no'>) => {
    if (side) return cur[key] === side ? cur : { ...cur, [key]: side };
    if (!(key in cur)) return cur;
    const next = { ...cur };
    delete next[key];
    return next;
  });
}

/**
 * #5463: a vote the server SAVED, by session id. castVote publishes it once,
 * from its ok branch only — never on a refusal, a network failure, an
 * `identity_required` retry or a cancelled No — so every Needs you surface
 * that did not cast the vote can mark its card anyway: the Communities feed's
 * kept store copy and its counts (features/workshop), and a board read from
 * before the vote (app-view.js `_overlayPendingVote` fills it from the page's
 * own record). A card voted elsewhere must read exactly like a card voted in
 * the feed, without waiting for the next read.
 */
export interface VoteSavedEntry {
  vote: 'yes' | 'no';
  /** The approval epoch the vote was saved at; null when the row had none. */
  epoch: number | null;
  /** Rises with each publish, so a re-vote is seen even of the same side. */
  seq: number;
}

/** How many entries the map keeps, newest first — a page's owed votes. */
export const VOTE_SAVED_MAX = 200;

export const voteSavedStore = createStore<Record<string, VoteSavedEntry>>({});

let voteSavedSeq = 0;

export function publishVoteSaved(sessionId: number, vote: 'yes' | 'no' | null, epoch: number | null): void {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return;
  // A vote taken back (AppView.retractVote, the new Needs you's Undo): the
  // change is owed again, so no screen may keep showing it as answered.
  if (vote === null) {
    voteSavedStore.set((cur: Record<string, VoteSavedEntry>) => {
      if (!(String(id) in cur)) return cur;
      const next: Record<string, VoteSavedEntry> = { ...cur };
      delete next[String(id)];
      return next;
    });
    return;
  }
  if (vote !== 'yes' && vote !== 'no') return;
  const e = epoch == null ? null : Number(epoch);
  voteSavedStore.set((cur: Record<string, VoteSavedEntry>) => {
    const next: Record<string, VoteSavedEntry> = { ...cur };
    // Re-add at the end, so "newest" is the map's own order.
    delete next[String(id)];
    next[String(id)] = {
      vote,
      epoch: e == null || !Number.isFinite(e) ? null : e,
      seq: ++voteSavedSeq,
    };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - VOTE_SAVED_MAX))) delete next[k];
    return next;
  });
}
