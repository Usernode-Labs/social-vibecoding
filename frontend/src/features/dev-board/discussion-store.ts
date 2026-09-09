/**
 * The app's general discussion, as the board's card sees it.
 *
 * ── Why the board carries it at all ────────────────────────────────────
 *
 * The general chat WAS the Activity destination. Activity is the board's
 * recency stream now, which left a screen with a composer reachable only from
 * a notification — so the discussion comes back to the board itself, in the
 * shape each of the board's two views calls for:
 *
 *   Kanban  — a CARD above the columns. The board is a prioritised worklist,
 *             and "the other place to go" is chrome on it, not work in it.
 *   Feed    — an ordinary activity ROW, sorted by its latest message like
 *             every other card (`AppView._discussionCardModel`). In a stream
 *             of what just happened, a conversation is one of the things that
 *             just happened, and a pinned tile above it would be a claim that
 *             it is not. Two rules follow from taking that literally: a chat
 *             nobody has posted in gets NO row (it is not activity), and the
 *             row it does get is exempt from the feed's 20-item page cap —
 *             one always-present row is not competing for the page, and on a
 *             busy board a quiet chat would otherwise vanish behind "Show
 *             more" on exactly the apps with the most going on. It still
 *             renders at its own sorted position inside that page.
 *
 * Two shapes, one fact, and this store is the fact: where the chat is and what
 * was last said in it. `AppView._loadDiscussionSummary()` publishes it after
 * one view-gated request for the newest message.
 *
 * ── The initial value is the pre-fetch card ────────────────────────────
 *
 * `href: null` renders no card at all — that is the state before an app is
 * open, and the board frame is not in the prerendered document anyway (an
 * interim root mounts it on the Dev route). Once a slug is published the card
 * draws immediately with the standing description, and the preview line
 * replaces it when the request lands. A card that waited for the fetch would
 * pop in a beat after the board, which is worse than a line that changes.
 */

import { createStore } from '../../lib/plain-store.js';

export interface DiscussionState {
  /** `#app/<slug>/dev/chat`, or null when no app is open. */
  href: string | null;
  /** "<who>: <what they said>", or the standing description before it lands. */
  preview: string;
}

export const discussionStore = createStore<DiscussionState>({
  href: null,
  preview: 'Talk with everyone building this app',
});
