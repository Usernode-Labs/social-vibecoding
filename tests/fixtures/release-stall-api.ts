/**
 * The Dev board frame plus the merged-but-not-released store, from one entry
 * — see ./dev-card-api.ts for why loading them separately would give the test
 * a different store object from the component's.
 */

export { DevBoardFrame } from '../../frontend/src/features/dev-board/board-frame';
export { releaseStallStore, releaseStallText } from '../../frontend/src/features/dev-board/release-stall-store';
