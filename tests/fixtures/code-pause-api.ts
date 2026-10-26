/**
 * The Dev board frame plus the code-changes-paused store, from one entry —
 * see ./dev-card-api.ts for why loading them separately would give the test
 * a different store object from the component's.
 */

export { DevBoardFrame } from '../../frontend/src/features/dev-board/board-frame';
export { codePauseStore } from '../../frontend/src/features/dev-board/code-pause-store';
