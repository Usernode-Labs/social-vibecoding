/**
 * ONE bundle exporting the Dev card components AND the stores they read.
 *
 * `loadTsx` bundles each entry point separately, so a test that loaded
 * `card/dev-feed.tsx` and `card/cards-store.ts` as two entries would get two
 * copies of the module graph and therefore two distinct store instances —
 * publishing into one and rendering the other. Re-exporting both from a
 * single entry is what keeps them the same objects. Same reason
 * ./group-chat-transcript-api.ts exists.
 */

export { ActionButton, DevCard, StatusPill, Badge, Preview, CardIcon, fmtCountdown, BADGE_MAX, ACTION_PRIMARY_MAX } from '../../frontend/src/features/dev-board/card/dev-card';
export { DevFeed, FooterView } from '../../frontend/src/features/dev-board/card/dev-feed';
export { DevKanban } from '../../frontend/src/features/dev-board/card/dev-kanban';
// The strip is a row of the FRAME now, not of the board — but it reads the
// same store, so it belongs in this one bundle for the same reason the rest
// of this file exists.
export { BoardTabs } from '../../frontend/src/features/dev-board/board-tabs';
export { TopicHead, NoteBoxView, ChecksVerdictView, ProposalBody } from '../../frontend/src/features/dev-board/topic/topic-head';
export { topicHeadStore } from '../../frontend/src/features/dev-board/topic/topic-store';
export { ListRowView } from '../../frontend/src/features/dev-board/card/list-rows';
export {
  devFeedStore,
  devKanbanStore,
  cardNowStore,
  aiEnabledStore,
} from '../../frontend/src/features/dev-board/card/cards-store';
