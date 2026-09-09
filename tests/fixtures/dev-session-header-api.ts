/**
 * The dev chat's session header plus its store, from one entry — see
 * ./dev-card-api.ts for why loading them separately would give the test a
 * different store object from the component's.
 */

export { SessionHeader, MergeStatusPill } from '../../frontend/src/features/dev-chat/session-header';
export { sessionHeaderStore } from '../../frontend/src/features/dev-chat/session-header-store';
// The strip's mode switch reads the preview facts off the improve store, so a
// test that drives the switch needs the SAME store object the component
// imports — the same reason the two above come from one entry.
export { improveStore } from '../../frontend/src/features/improve/improve-store.js';
